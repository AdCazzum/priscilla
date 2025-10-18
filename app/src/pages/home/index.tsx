import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Grid,
  GridItem,
  Input,
  Navbar as MeroNavbar,
  NavbarBrand,
  NavbarMenu,
  NavbarItem,
  Text,
  useToast,
} from '@calimero-network/mero-ui';
import {
  CalimeroConnectButton,
  ConnectionType,
  useCalimero,
} from '@calimero-network/calimero-client';
import { useNavigate } from 'react-router-dom';
import * as webllm from '@mlc-ai/web-llm';
import translations from '../../constants/en.global.json';
import { AbiClient, createChatClient } from '../../features/kv/api';
import type {
  AnswerResult,
  ChatMessage as StoredMessage,
  GameInfo,
} from '../../api/AbiClient';

type ConversationRole = 'system' | 'user' | 'assistant';

type HomePageMode = 'full' | 'admin' | 'player-one' | 'player-two';

interface ConversationMessage {
  id: string;
  role: ConversationRole;
  content: string;
  sender: string;
  timestamp: number;
}

interface StreamEventEntry {
  id: string;
  name: string;
  raw: string | null;
  parsed: unknown;
  event: unknown;
  metadata: EventMessageMetadata[];
  timestamp: number;
}

type EventMessageMetadata = {
  id: number;
  role: string;
  sender: string;
  content?: string | null;
  timestampMs?: number | null;
};

const MODEL_NAME = 'Phi-3-mini-4k-instruct-q4f16_1-MLC';
const MAX_HISTORY = 200;

interface HomePageProps {
  mode?: HomePageMode;
}

export default function HomePage({ mode = 'full' }: HomePageProps): JSX.Element {
  const navigate = useNavigate();
  const { isAuthenticated, logout, app, appUrl } = useCalimero();
  const { show } = useToast();

  const [displayName, setDisplayName] = useState<string>('admin');
  const [input, setInput] = useState<string>('');
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [gameInfo, setGameInfo] = useState<GameInfo | null>(null);
  const [apiClient, setApiClient] = useState<AbiClient | null>(null);
  const [engine, setEngine] =
    useState<webllm.WebWorkerMLCEngine | null>(null);
  const [engineStatus, setEngineStatus] = useState<string>('Loading model…');
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState<boolean>(false);
  const [engineReady, setEngineReady] = useState<boolean>(false);
  const [eventStreamStatus, setEventStreamStatus] =
    useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [eventLog, setEventLog] = useState<StreamEventEntry[]>([]);
  const [contextIds, setContextIds] = useState<string[]>([]);
  const [isEventPanelCollapsed, setIsEventPanelCollapsed] =
    useState<boolean>(false);
  const [setupAdminName, setSetupAdminName] = useState<string>('admin');
  const [setupPlayerOne, setSetupPlayerOne] =
    useState<string>('player-one');
  const [setupPlayerTwo, setSetupPlayerTwo] =
    useState<string>('player-two');
  const [secretInput, setSecretInput] = useState<string>('');
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [latestGuessWasCorrect, setLatestGuessWasCorrect] =
    useState<boolean | null>(null);
  const [llmPrompt, setLlmPrompt] = useState<string>(
    'Never reveal the secret word. Answer player questions with “yes” or “no” when appropriate, followed by a brief, encouraging hint that nudges them closer to the correct answer.',
  );
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const messagesRef = useRef<ConversationMessage[]>([]);
  const respondedMessageIdsRef = useRef<Set<string>>(new Set());
  const pendingAssistantRef = useRef<Map<string, string>>(new Map());
  const subscriptionContextIdsRef = useRef<string[] | null>(null);
  const subscriptionKeyRef = useRef<string | null>(null);
  const hasSeenEventRef = useRef<boolean>(false);

  const connectionTarget = useMemo(() => {
    if (!appUrl) {
      return 'http://node1.127.0.0.1.nip.io';
    }
    return appUrl;
  }, [appUrl]);

  const contextsKey = useMemo(() => {
    if (contextIds.length === 0) {
      return null;
    }
    return [...contextIds].sort().join('|');
  }, [contextIds]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/');
    }
  }, [isAuthenticated, navigate]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (!app) return;

    let cancelled = false;
    (async () => {
      try {
        const client = await createChatClient(app);
        if (!cancelled) {
          setApiClient(client);
        }
      } catch (error) {
        console.error('Failed to create chat client', error);
        if (!cancelled) {
          show({
            title: 'Failed to initialise contract client',
            variant: 'error',
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [app, show]);

  useEffect(() => {
    if (!workerRef.current) {
      workerRef.current = new Worker(
        new URL('../../workers/llm.worker.ts', import.meta.url),
        { type: 'module' },
      );
    }

    const worker = workerRef.current;

    webllm
      .CreateWebWorkerMLCEngine(worker, MODEL_NAME, {
        initProgressCallback: (progress) => {
          setEngineStatus(progress.text);
        },
      })
      .then((newEngine) => {
        setEngine(newEngine);
        setEngineReady(true);
        setEngineStatus('Model ready');
      })
      .catch((error) => {
        console.error('Failed to initialise web-llm engine', error);
        setEngineStatus('Failed to load model');
        show({
          title: 'Failed to load language model',
          variant: 'error',
        });
      });

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [show]);

  const normaliseStoredMessages = useCallback(
    (stored: StoredMessage[]): ConversationMessage[] =>
      stored.map((msg) => ({
        id: `stored-${msg.id}`,
        role: sanitiseRole(msg.role),
        content: msg.content,
        sender: msg.sender,
        timestamp: msg.timestamp_ms,
      })),
    [],
  );

  const loadHistory = useCallback(async () => {
    if (!apiClient) return;
    setIsLoadingHistory(true);
    try {
      const [history, infoSnapshot] = await Promise.all([
        apiClient.messages({ offset: 0, limit: MAX_HISTORY }),
        apiClient.gameInfo(),
      ]);
      setMessages(normaliseStoredMessages(history));
      setGameInfo(infoSnapshot);
      setTimeout(scrollToBottom, 100);
    } catch (error) {
      console.error('Failed to load messages', error);
      show({
        title: 'Failed to load chat history',
        variant: 'error',
      });
    } finally {
      setIsLoadingHistory(false);
    }
  }, [apiClient, normaliseStoredMessages, scrollToBottom, show]);

  const refreshGameInfoOnly = useCallback(async () => {
    if (!apiClient) return;
    try {
      const snapshot = await apiClient.gameInfo();
      setGameInfo(snapshot);
    } catch (error) {
      console.error('Failed to refresh game info', error);
    }
  }, [apiClient]);

  useEffect(() => {
    if (apiClient) {
      loadHistory();
    }
  }, [apiClient, loadHistory]);

  const appendStreamEvent = useCallback(
    (name: string, payload: unknown, original?: unknown) => {
      const normalised = normaliseEventPayload(payload);

      let parsed: unknown = normalised;
      let raw: string | null = null;

      if (typeof normalised === 'string') {
        raw = normalised;
        if (normalised.length > 0) {
          try {
            parsed = JSON.parse(normalised);
          } catch (_error) {
            parsed = normalised;
          }
        }
      } else if (normalised !== null && normalised !== undefined) {
        try {
          raw = JSON.stringify(normalised, null, 2);
        } catch (_error) {
          raw = String(normalised);
        }
      }

      setEventLog((previous) => {
        const metadata = extractMessageMetadata(original ?? normalised);
        const entry: StreamEventEntry = {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          name,
          raw,
          parsed,
          event: original ?? payload,
          metadata,
          timestamp: Date.now(),
        };
        const next = [entry, ...previous];
        return next.slice(0, 100);
      });
    },
    [],
  );

  const fetchSubscriptionContexts = useCallback(async () => {
    if (!app) return;
    try {
      setEventStreamStatus('connecting');
      console.log('[Events] Fetching contexts for subscription…');
      const contexts = await app.fetchContexts();
      console.log(
        '[Events] Contexts resolved:',
        contexts.map((context) => context.contextId),
      );
      setContextIds(contexts.map((context) => context.contextId));
    } catch (error) {
      console.error('Failed to fetch contexts for event subscription', error);
      setContextIds([]);
      setEventStreamStatus('error');
      show({
        title: 'Unable to subscribe to contract events',
        variant: 'error',
      });
    }
  }, [app, show]);

  useEffect(() => {
    if (apiClient) {
      void fetchSubscriptionContexts();
    }
  }, [apiClient, fetchSubscriptionContexts]);

  useEffect(() => {
    if (!app || !isAuthenticated) {
      setEventStreamStatus('idle');
      setEventLog([]);
      setContextIds([]);
      return;
    }

    fetchSubscriptionContexts();
  }, [app, fetchSubscriptionContexts, isAuthenticated]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const buildLlmContext = useCallback(
    (
      history: ConversationMessage[],
      systemMessage?: string,
    ): webllm.ChatCompletionMessageParam[] => {
      const context: webllm.ChatCompletionMessageParam[] = [];
      if (systemMessage && systemMessage.trim().length > 0) {
        context.push({
          role: 'system',
          content: systemMessage,
        });
      }
      for (const message of history) {
        context.push({
          role: message.role,
          content: message.content,
        });
      }
      return context;
    },
    [],
  );

  const normaliseStoredMessage = useCallback(
    (stored: StoredMessage): ConversationMessage => ({
      id: `stored-${stored.id}`,
      role: sanitiseRole(stored.role),
      content: stored.content,
      sender: stored.sender,
      timestamp: stored.timestamp_ms,
    }),
    [],
  );

  const submitQuestion = useCallback(
    async (playerName: string, content: string) => {
      if (!apiClient) return null;
      try {
        const stored = await apiClient.submitQuestion({
          player: playerName,
          content,
        });
        return normaliseStoredMessage(stored);
      } catch (error) {
        console.error('Failed to submit question', error);
        show({
          title: 'Unable to submit question',
          variant: 'error',
        });
        return null;
      }
    },
    [apiClient, normaliseStoredMessage, show],
  );

  const submitAnswer = useCallback(
    async (
      playerName: string,
      content: string,
      guess: string | null,
    ): Promise<{ message: ConversationMessage | null; guessWasCorrect: boolean }> => {
      if (!apiClient) {
        return { message: null, guessWasCorrect: false };
      }
      try {
        const response: AnswerResult = await apiClient.submitAnswer({
          player: playerName,
          content,
          guess,
        });
        return {
          message: normaliseStoredMessage(response.message),
          guessWasCorrect: response.guess_was_correct,
        };
      } catch (error) {
        console.error('Failed to submit answer', error);
        show({
          title: 'Unable to submit answer',
          variant: 'error',
        });
        return { message: null, guessWasCorrect: false };
      }
    },
    [apiClient, normaliseStoredMessage, show],
  );

  const fetchMessageById = useCallback(
    async (id: number): Promise<StoredMessage | null> => {
      if (!apiClient) return null;
      try {
        const result = await apiClient.messageById({ id });
        return result ?? null;
      } catch (error) {
        console.error('Failed to fetch message by id', error);
        return null;
      }
    },
    [apiClient],
  );

  const generateAssistantResponse = useCallback(
    async (triggerMessage: ConversationMessage) => {
      if (!engine || !engineReady) {
        return;
      }
      const playerTwoName = gameInfo?.player_two?.trim();
      if (!playerTwoName) {
        return;
      }
      if (respondedMessageIdsRef.current.has(triggerMessage.id)) {
        return;
      }

      respondedMessageIdsRef.current.add(triggerMessage.id);
      setIsGenerating(true);

      let secretForPrompt: string | null = null;
      if (apiClient) {
        try {
          const secretValue = await apiClient.getSecret({
            requester: playerTwoName,
          });
          if (typeof secretValue === 'string' && secretValue.length > 0) {
            secretForPrompt = secretValue;
          }
        } catch (error) {
          console.error('Failed to fetch secret for LLM prompt', error);
        }
      }

      const placeholderId = `assistant-pending-${triggerMessage.id}`;
      pendingAssistantRef.current.set(triggerMessage.id, placeholderId);

      const placeholder: ConversationMessage = {
        id: placeholderId,
        role: 'player_two',
        content: 'Generating response…',
        sender: playerTwoName,
        timestamp: Date.now(),
      };

      const withPlaceholder = upsertMessage(
        removeMessageById(messagesRef.current, placeholderId),
        placeholder,
      );
      messagesRef.current = withPlaceholder;
      setMessages(withPlaceholder);
      appendStreamEvent('LLM generating', {
        triggerId: triggerMessage.id,
        content: triggerMessage.content,
        sender: triggerMessage.sender,
      });

      try {
        const history = messagesRef.current.filter(
          (message) => message.id !== placeholderId,
        );
        const promptParts = [] as string[];
        if (llmPrompt.trim().length > 0) {
          promptParts.push(llmPrompt.trim());
        }
        promptParts.push(
          `Secret word: ${secretForPrompt != null ? secretForPrompt : 'N/A'}`,
        );
        const systemPrompt = promptParts.join('\n\n');
        const llmMessages = buildLlmContext(history, systemPrompt);
        const lastMessage = llmMessages[llmMessages.length - 1];
        if (!lastMessage || lastMessage.role !== 'user') {
          throw new Error('Conversation last turn is not a user message');
        }
        const completion = await engine.chat.completions.create({
          messages: llmMessages,
          temperature: 0.7,
        });

        const assistantText = extractAssistantContent(completion);
        if (!assistantText) {
          throw new Error('No assistant response returned');
        }

        const { message: persistedAssistant, guessWasCorrect } =
          await submitAnswer(playerTwoName, assistantText, null);
        setLatestGuessWasCorrect(guessWasCorrect ? true : null);
        pendingAssistantRef.current.delete(triggerMessage.id);

        const conversationAssistant =
          persistedAssistant ?? {
            id: `local-${Date.now()}`,
            role: 'player_two',
            content: assistantText,
            sender: playerTwoName,
            timestamp: Date.now(),
          };

        const withoutPlaceholder = removeMessageById(
          messagesRef.current,
          placeholderId,
        );
        const finalList = upsertMessage(
          withoutPlaceholder,
          conversationAssistant,
        );
        messagesRef.current = finalList;
        setMessages(finalList);
        appendStreamEvent('LLM response ready', {
          triggerId: triggerMessage.id,
          responseId: conversationAssistant.id,
        });
      } catch (error) {
        console.error('Failed to generate assistant response', error);
        respondedMessageIdsRef.current.delete(triggerMessage.id);
        const placeholderIdExisting = pendingAssistantRef.current.get(
          triggerMessage.id,
        );
        if (placeholderIdExisting) {
          pendingAssistantRef.current.delete(triggerMessage.id);
          const withoutPlaceholder = removeMessageById(
            messagesRef.current,
            placeholderIdExisting,
          );
          messagesRef.current = withoutPlaceholder;
          setMessages(withoutPlaceholder);
        }
        appendStreamEvent('LLM response failed', {
          triggerId: triggerMessage.id,
          reason: error instanceof Error ? error.message : String(error),
        });
        show({
          title: 'The assistant failed to respond',
          variant: 'error',
        });
      } finally {
        setIsGenerating(false);
      }
    },
    [
      apiClient,
      appendStreamEvent,
      buildLlmContext,
      engine,
      engineReady,
      gameInfo,
      llmPrompt,
      show,
      submitAnswer,
    ],
  );

  const handleIncomingStoredMessage = useCallback(
    (stored: StoredMessage) => {
      const conversationMessage = normaliseStoredMessage(stored);
      const messageKey = conversationMessage.id;

      const placeholderId = pendingAssistantRef.current.get(messageKey);
      let baseList = messagesRef.current;
      if (placeholderId) {
        baseList = removeMessageById(baseList, placeholderId);
        pendingAssistantRef.current.delete(messageKey);
      }

      const nextMessages = upsertMessage(baseList, conversationMessage);
      messagesRef.current = nextMessages;
      setMessages(nextMessages);

      if (conversationMessage.role === 'user') {
        void generateAssistantResponse(conversationMessage);
      }
    },
    [generateAssistantResponse, normaliseStoredMessage],
  );

  const processMessageMetadata = useCallback(
    async (metadataList: EventMessageMetadata[]) => {
      await Promise.all(
        metadataList.map(async (metadata) => {
          const storedId = `stored-${metadata.id}`;
          const existing = messagesRef.current.find(
            (message) => message.id === storedId,
          );

          let stored: StoredMessage | null = null;
          if (existing) {
            stored = {
              id: metadata.id,
              sender: existing.sender,
              role: existing.role,
              content: existing.content,
              timestamp_ms: existing.timestamp,
            };
          } else if (metadata.content != null) {
            stored = {
              id: metadata.id,
              sender: metadata.sender,
              role: metadata.role,
              content: metadata.content ?? '',
              timestamp_ms:
                typeof metadata.timestampMs === 'number'
                  ? metadata.timestampMs
                  : Date.now(),
            };
          } else {
            stored = await fetchMessageById(metadata.id);
          }

          if (stored) {
            handleIncomingStoredMessage(stored);
          }
        }),
      );
    },
    [fetchMessageById, handleIncomingStoredMessage],
  );

  const processEventMetadata = useCallback(
    async (metadataList: EventMessageMetadata[]) => {
      if (metadataList.length === 0) {
        return;
      }

      const unseenMetadata = metadataList.filter((metadata) => {
        const storedId = `stored-${metadata.id}`;
        return !messagesRef.current.some(
          (message) => message.id === storedId,
        );
      });

      const toProcess =
        unseenMetadata.length > 0 ? unseenMetadata : metadataList;

      await processMessageMetadata(toProcess);
    },
    [processMessageMetadata],
  );

  const handleContractEvent = useCallback(
    (event: unknown) => {
      hasSeenEventRef.current = true;
      console.log('[Events] Received node event:', event);
      setEventStreamStatus('connected');
      const asRecord =
        event && typeof event === 'object'
          ? (event as Record<string, unknown>)
          : null;
      const eventName =
        (asRecord?.type as string | undefined) ?? 'contract-event';
      appendStreamEvent(eventName, event, event);
      void refreshGameInfoOnly();

      const eventMessages = extractMessageMetadata(event);
      if (eventMessages.length > 0) {
        void processEventMetadata(eventMessages);
      }
    },
    [appendStreamEvent, extractMessageMetadata, processEventMetadata, refreshGameInfoOnly],
  );

  const handleGenerateFromEvent = useCallback(
    async (entry: StreamEventEntry) => {
      const source = entry.event ?? entry.parsed ?? entry.raw;
      if (!source) {
        show({
          title: 'Event payload missing',
          variant: 'warning',
        });
        return;
      }

      const metadata =
        entry.metadata.length > 0
          ? entry.metadata
          : extractMessageMetadata(source);

      if (metadata.length > 0) {
        await processMessageMetadata(metadata);

        const includesUser = metadata.some(
          (meta) => sanitiseRole(meta.role) === 'user',
        );
        if (includesUser) {
          return;
        }
      }

      await loadHistory();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const latestUser = [...messagesRef.current]
        .reverse()
        .find(
          (message) =>
            message.role === 'user' &&
            !respondedMessageIdsRef.current.has(message.id),
        );

      if (!latestUser) {
        show({
          title: 'No user message found to process',
          variant: 'warning',
        });
        return;
      }

      await generateAssistantResponse(latestUser);
    },
    [
      generateAssistantResponse,
      loadHistory,
      processMessageMetadata,
      show,
    ],
  );

  useEffect(() => {
    if (!app || !isAuthenticated) {
      if (subscriptionContextIdsRef.current) {
        console.log(
          '[Events] Clearing subscriptions due to auth change:',
          subscriptionContextIdsRef.current,
        );
        app.unsubscribeFromEvents(subscriptionContextIdsRef.current);
        subscriptionContextIdsRef.current = null;
        subscriptionKeyRef.current = null;
      }
      hasSeenEventRef.current = false;
      setEventStreamStatus('idle');
      return;
    }

    if (contextIds.length === 0) {
      if (subscriptionContextIdsRef.current) {
        console.log(
          '[Events] No contexts available, unsubscribing:',
          subscriptionContextIdsRef.current,
        );
        app.unsubscribeFromEvents(subscriptionContextIdsRef.current);
        subscriptionContextIdsRef.current = null;
        subscriptionKeyRef.current = null;
      }
      hasSeenEventRef.current = false;
      setEventStreamStatus('idle');
      return;
    }

    if (!contextsKey) {
      return;
    }

    if (subscriptionKeyRef.current === contextsKey) {
      return;
    }

    if (subscriptionContextIdsRef.current) {
      console.log(
        '[Events] Switching contexts, unsubscribing:',
        subscriptionContextIdsRef.current,
      );
      app.unsubscribeFromEvents(subscriptionContextIdsRef.current);
      subscriptionContextIdsRef.current = null;
      subscriptionKeyRef.current = null;
    }

    hasSeenEventRef.current = false;
    setEventStreamStatus('connecting');
    console.log('[Events] Subscribing to contexts:', contextIds);
    app.subscribeToEvents(contextIds, handleContractEvent);
    setEventStreamStatus('connected');
    subscriptionContextIdsRef.current = [...contextIds];
    subscriptionKeyRef.current = contextsKey;
    console.log('[Events] Subscription request sent');
  }, [
    app,
    contextsKey,
    contextIds,
    handleContractEvent,
    isAuthenticated,
  ]);

  useEffect(() => {
    if (
      !app ||
      !isAuthenticated ||
      contextIds.length === 0 ||
      hasSeenEventRef.current
    ) {
      return;
    }

    const retryTimer = window.setInterval(() => {
      console.log('[Events] Retrying subscription for contexts:', contextIds);
      app.subscribeToEvents(contextIds, handleContractEvent);
    }, 2500);

    return () => {
      window.clearInterval(retryTimer);
    };
  }, [
    app,
    contextIds,
    eventStreamStatus,
    handleContractEvent,
    isAuthenticated,
  ]);

  useEffect(() => {
    return () => {
      if (subscriptionContextIdsRef.current && app) {
        console.log(
          '[Events] Component unmount, unsubscribing:',
          subscriptionContextIdsRef.current,
        );
        app.unsubscribeFromEvents(subscriptionContextIdsRef.current);
      }
      subscriptionContextIdsRef.current = null;
      subscriptionKeyRef.current = null;
    };
  }, [app]);

  useEffect(() => {
    if (eventStreamStatus !== 'connecting') {
      return;
    }

    const timer = window.setTimeout(() => {
      setEventStreamStatus((currentStatus) =>
        currentStatus === 'connecting' ? 'connected' : currentStatus,
      );
    }, 1200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [eventStreamStatus]);

  const stageName = useMemo(
    () => extractStageName(gameInfo?.stage),
    [gameInfo?.stage],
  );

  const stageKey = useMemo(
    () => (stageName ? canonicalStageKey(stageName) : null),
    [stageName],
  );

  const handleSendMessage = useCallback(async () => {
    const trimmedContent = input.trim();
    const playerName = displayName.trim();
    if (!trimmedContent || !apiClient || !gameInfo) {
      return;
    }
    if (playerName.length === 0) {
      show({
        title: 'No active participant selected yet',
        variant: 'warning',
      });
      return;
    }

    setInput('');
    setLatestGuessWasCorrect(null);

    let messagePersisted: ConversationMessage | null = null;

    if (stageKey === 'waitingforquestion') {
      if (gameInfo.player_one && playerName !== gameInfo.player_one) {
        show({
          title: 'It is not your turn',
          variant: 'warning',
        });
        return;
      }

      messagePersisted = await submitQuestion(playerName, trimmedContent);
    } else if (stageKey === 'waitingforanswer') {
      show({
        title: 'Player two replies via the LLM trigger',
        variant: 'warning',
      });
      return;
    } else {
      show({
        title: 'The game is not ready for messages yet',
        variant: 'warning',
      });
      return;
    }

    if (messagePersisted) {
      const nextMessages = upsertMessage(
        messagesRef.current,
        messagePersisted,
      );
      messagesRef.current = nextMessages;
      setMessages(nextMessages);
    }

    await refreshGameInfoOnly();
  }, [
    apiClient,
    displayName,
    gameInfo,
    input,
    stageKey,
    refreshGameInfoOnly,
    show,
    submitQuestion,
  ]);

  const handleClearChat = useCallback(async () => {
    if (!apiClient) return;
    const requester = displayName.trim();
    if (!requester) {
      show({
        title: 'Only the admin can clear the history',
        variant: 'warning',
      });
      return;
    }
    try {
      await apiClient.clearHistory({ requester });
      setMessages([]);
      messagesRef.current = [];
      respondedMessageIdsRef.current.clear();
      pendingAssistantRef.current.clear();
      await refreshGameInfoOnly();
      show({
        title: 'Chat history cleared',
        variant: 'success',
      });
    } catch (error) {
      console.error('Failed to clear history', error);
      show({
        title: 'Unable to clear history',
        variant: 'error',
      });
    }
  }, [apiClient, displayName, refreshGameInfoOnly, show]);

  const handleCreateGame = useCallback(async () => {
    if (!apiClient) return;
    const admin = setupAdminName.trim();
    const playerOne = setupPlayerOne.trim();
    const playerTwo = setupPlayerTwo.trim();
    if (!admin || !playerOne || !playerTwo) {
      show({
        title: 'Fill in all fields to create the game',
        variant: 'warning',
      });
      return;
    }

    try {
      const infoSnapshot = await apiClient.createGame({
        admin,
        player_one: playerOne,
        player_two: playerTwo,
      });
      setGameInfo(infoSnapshot);
      setMessages([]);
      messagesRef.current = [];
      respondedMessageIdsRef.current.clear();
      pendingAssistantRef.current.clear();
      setRevealedSecret(null);
      setLatestGuessWasCorrect(null);
      show({
        title: 'New game created',
        variant: 'success',
      });
    } catch (error) {
      console.error('Failed to create game', error);
      show({
        title: 'Unable to create the game',
        variant: 'error',
      });
    }
  }, [
    apiClient,
    setupAdminName,
    setupPlayerOne,
    setupPlayerTwo,
    show,
  ]);

  const handleSetSecret = useCallback(async () => {
    if (!apiClient) return;
    const requester = displayName.trim();
    const secretValue = secretInput.trim();
    if (!requester || !secretValue) {
      show({
        title: 'Provide the admin name and a valid secret',
        variant: 'warning',
      });
      return;
    }

    try {
      const infoSnapshot = await apiClient.setSecret({
        requester,
        secret: secretValue,
      });
      setSecretInput('');
      setGameInfo(infoSnapshot);
      show({
        title: 'Secret updated',
        variant: 'success',
      });
    } catch (error) {
      console.error('Failed to set secret', error);
      show({
        title: 'Unable to set the secret',
        variant: 'error',
      });
    }
  }, [apiClient, displayName, secretInput, show]);

  const handleRevealSecret = useCallback(async () => {
    if (!apiClient) return;
    const requester = displayName.trim();
    if (!requester) {
      show({
        title: 'Set your name to request the secret',
        variant: 'warning',
      });
      return;
    }

    try {
      const secretValue = await apiClient.getSecret({ requester });
      if (secretValue) {
        setRevealedSecret(secretValue);
        show({
          title: 'Secret retrieved',
          variant: 'success',
        });
      } else {
        setRevealedSecret(null);
        show({
          title: 'No access to the secret',
          variant: 'warning',
        });
      }
    } catch (error) {
      console.error('Failed to fetch secret', error);
      show({
        title: 'Failed to retrieve the secret',
        variant: 'error',
      });
    }
  }, [apiClient, displayName, show]);

  const handleDebugRevealSecret = useCallback(async () => {
    if (!apiClient) return;
    try {
      const secretValue = await apiClient.debugRevealSecret();
      setRevealedSecret(secretValue ?? null);
      show({
        title: 'Secret (debug) retrieved',
        variant: 'success',
      });
    } catch (error) {
      console.error('Failed to debug reveal secret', error);
      show({
        title: 'Failed to reveal secret in debug mode',
        variant: 'error',
      });
    }
  }, [apiClient, show]);

  const connectionBadge = useMemo(() => {
    if (!appUrl) return null;
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: '0.25rem',
        }}
      >
        <Text size="sm" color="muted" style={{ fontSize: '0.75rem' }}>
          Connected node
        </Text>
        <Text
          size="sm"
          style={{ fontFamily: 'monospace', color: '#e5e7eb' }}
        >
          {appUrl.replace(/^https?:\/\//, '')}
        </Text>
      </div>
    );
  }, [appUrl]);

  const stageLabel = useMemo(() => {
    switch (stageKey) {
      case 'waitingforsecret':
        return 'Waiting for secret';
      case 'waitingforquestion':
        return 'Player 1 turn';
      case 'waitingforanswer':
        return 'Player 2 turn';
      case 'completed':
        return 'Game completed';
      case 'notstarted':
      default:
        return 'Needs configuration';
    }
  }, [stageKey]);

  const awaitingPlayerLabel = useMemo(() => {
    if (!gameInfo?.awaiting_player) {
      return '—';
    }
    return gameInfo.awaiting_player;
  }, [gameInfo?.awaiting_player]);

  const currentRoleLabel = useMemo(() => {
    const trimmed = displayName.trim();
    if (!trimmed) {
      return 'Unset';
    }
    if (gameInfo?.admin && trimmed === gameInfo.admin) {
      return 'Admin';
    }
    if (gameInfo?.player_one && trimmed === gameInfo.player_one) {
      return 'Player 1';
    }
    if (gameInfo?.player_two && trimmed === gameInfo.player_two) {
      return 'Player 2';
    }
    return 'Observer';
  }, [displayName, gameInfo]);

  const secretStatusLabel = useMemo(() => {
    if (!gameInfo) {
      return '—';
    }
    return gameInfo.secret_set ? 'Secret ready' : 'Secret missing';
  }, [gameInfo]);

  const namesLocked = useMemo(
    () => Boolean(gameInfo?.admin && stageKey && stageKey !== 'notstarted'),
    [gameInfo?.admin, stageKey],
  );

  const showSetupCard = mode === 'full' || mode === 'admin';
  const showSecretCard = mode === 'full' || mode === 'admin';
  const showEventsCard = mode === 'full' || mode === 'player-two';
  const showConversationCard = mode !== 'admin';
  const showSendCard = mode === 'full' || mode === 'player-one';
  const showPromptEditor = mode === 'full' || mode === 'admin';

  useEffect(() => {
    if (mode === 'full') {
      if (!gameInfo) {
        return;
      }
      let expectedName: string | null = null;
      switch (stageKey) {
        case 'waitingforsecret':
        case 'notstarted':
          expectedName = gameInfo.admin ?? setupAdminName;
          break;
        case 'waitingforquestion':
          expectedName = gameInfo.player_one ?? setupPlayerOne;
          break;
        case 'waitingforanswer':
          expectedName = gameInfo.player_two ?? setupPlayerTwo;
          break;
        case 'completed':
          expectedName =
            gameInfo.player_two ??
            gameInfo.player_one ??
            gameInfo.admin ??
            setupAdminName;
          break;
        default:
          break;
      }
      if (expectedName && expectedName.length > 0 && displayName !== expectedName) {
        setDisplayName(expectedName);
      }
      return;
    }

    let targetName: string | null = null;
    if (mode === 'admin') {
      targetName = gameInfo?.admin ?? setupAdminName;
    } else if (mode === 'player-one') {
      targetName = gameInfo?.player_one ?? setupPlayerOne;
    } else if (mode === 'player-two') {
      targetName = gameInfo?.player_two ?? setupPlayerTwo;
    }

    if (targetName && targetName.length > 0 && displayName !== targetName) {
      setDisplayName(targetName);
    }
  }, [
    displayName,
    gameInfo?.admin,
    gameInfo?.player_one,
    gameInfo?.player_two,
    mode,
    setupAdminName,
    setupPlayerOne,
    setupPlayerTwo,
    stageKey,
  ]);

  return (
    <>
      <MeroNavbar variant="elevated" size="md">
        <NavbarBrand text={translations.auth.title} />
        <NavbarMenu align="center">{connectionBadge}</NavbarMenu>
        <NavbarMenu align="center">
          <NavbarItem>
            <Button
              variant="ghost"
              onClick={() => navigate('/home')}
            >
              Full view
            </Button>
          </NavbarItem>
          <NavbarItem>
            <Button
              variant="ghost"
              onClick={() => navigate('/p-admin')}
            >
              Admin
            </Button>
          </NavbarItem>
          <NavbarItem>
            <Button
              variant="ghost"
              onClick={() => navigate('/player-one')}
            >
              Player One
            </Button>
          </NavbarItem>
          <NavbarItem>
            <Button
              variant="ghost"
              onClick={() => navigate('/player-two')}
            >
              Player Two
            </Button>
          </NavbarItem>
        </NavbarMenu>
        <NavbarMenu align="right">
          <NavbarItem>
            <CalimeroConnectButton
              connectionType={{
                type: ConnectionType.Custom,
                url: connectionTarget,
              }}
            />
          </NavbarItem>
          <NavbarItem>
            <Button variant="ghost" onClick={logout}>
              {translations.home.logout}
            </Button>
          </NavbarItem>
        </NavbarMenu>
      </MeroNavbar>
      <div
        style={{
          minHeight: '100vh',
          backgroundColor: '#0f172a',
          padding: '2rem 1rem',
        }}
      >
        <Grid columns={1} maxWidth="100%" justify="center">
          <GridItem>
            <div
              style={{
                maxWidth: '960px',
                margin: '0 auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '1.5rem',
              }}
            >
              <Card variant="rounded">
                <CardHeader>
                  <CardTitle>Web LLM Chat</CardTitle>
                </CardHeader>
                <CardContent
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '1rem',
                  }}
                >
                  <Text size="sm" color="muted">
                    {engineStatus}
                  </Text>
                  <div
                    style={{
                      display: 'flex',
                      gap: '1rem',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ flex: '1 1 220px', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                      <Text size="sm" color="muted">
                        Active participant
                      </Text>
                      <Text
                        size="lg"
                        style={{ fontWeight: 600, color: '#e5e7eb' }}
                      >
                        {displayName || '—'}
                      </Text>
                      <Text size="xs" color="muted">
                        Automatically follows the game turn order.
                      </Text>
                    </div>
                    <div style={{ flex: '1 1 220px', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                      <Text size="sm" color="muted">
                        Current role
                      </Text>
                      <Text
                        size="lg"
                        style={{ fontWeight: 600, color: '#e5e7eb' }}
                      >
                        {currentRoleLabel}
                      </Text>
                      <Text size="xs" color="muted">
                        Current turn: {awaitingPlayerLabel}
                      </Text>
                    </div>
                    <div style={{ flex: '1 1 220px', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                      <Text size="sm" color="muted">
                        Game stage
                      </Text>
                      <Text
                        size="lg"
                        style={{ fontWeight: 600, color: '#e5e7eb' }}
                      >
                        {stageLabel}
                      </Text>
                      <Text size="xs" color="muted">
                        {secretStatusLabel}
                      </Text>
                    </div>
                    <div style={{ flex: '1 1 220px', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                      <Text size="sm" color="muted">
                        Stored messages
                      </Text>
                      <Text
                        size="lg"
                        style={{ fontWeight: 600, color: '#e5e7eb' }}
                      >
                        {gameInfo
                          ? `${gameInfo.total_messages}/${gameInfo.max_messages}`
                          : '—'}
                      </Text>
                      <Text size="xs" color="muted">
                        Engine: {MODEL_NAME}
                      </Text>
                    </div>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      gap: '0.75rem',
                      flexWrap: 'wrap',
                    }}
                  >
                    <Button
                      variant="secondary"
                      onClick={loadHistory}
                      disabled={isLoadingHistory}
                    >
                      {isLoadingHistory ? 'Refreshing…' : 'Refresh history'}
                    </Button>
                    <Button variant="ghost" onClick={refreshGameInfoOnly}>
                      Refresh status
                    </Button>
                    <Button variant="error" onClick={handleClearChat}>
                      Clear history
                    </Button>
                  </div>
                  {showSetupCard && (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.5rem',
                        padding: '0.75rem',
                        background: 'rgba(15, 23, 42, 0.45)',
                        borderRadius: '10px',
                        border: '1px solid rgba(148, 163, 184, 0.18)',
                      }}
                    >
                      <Text size="sm" color="muted">
                        Game setup
                      </Text>
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '0.75rem',
                        }}
                      >
                        <Input
                          value={setupAdminName}
                          onChange={(event) =>
                            setSetupAdminName(event.target.value)
                          }
                          placeholder="Admin name"
                          style={{ flex: '1 1 200px' }}
                          disabled={namesLocked}
                        />
                        <Input
                          value={setupPlayerOne}
                          onChange={(event) =>
                            setSetupPlayerOne(event.target.value)
                          }
                          placeholder="Player 1 name"
                          style={{ flex: '1 1 200px' }}
                          disabled={namesLocked}
                        />
                        <Input
                          value={setupPlayerTwo}
                          onChange={(event) =>
                            setSetupPlayerTwo(event.target.value)
                          }
                          placeholder="Player 2 name"
                          style={{ flex: '1 1 200px' }}
                          disabled={namesLocked}
                        />
                      </div>
                      {namesLocked && (
                        <Text size="xs" color="muted">
                          Names are locked while the current game is active.
                        </Text>
                      )}
                      <Button variant="primary" onClick={handleCreateGame}>
                        Create or reset game
                      </Button>
                    </div>
                  )}
                  {showSecretCard && (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.5rem',
                        padding: '0.75rem',
                        background: 'rgba(15, 23, 42, 0.45)',
                        borderRadius: '10px',
                        border: '1px solid rgba(148, 163, 184, 0.18)',
                      }}
                    >
                      <Text size="sm" color="muted">
                        Secret management
                      </Text>
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '0.75rem',
                        }}
                      >
                        <Input
                          value={secretInput}
                          onChange={(event) =>
                            setSecretInput(event.target.value)
                          }
                          placeholder="Secret word (single word)"
                          style={{ flex: '1 1 240px' }}
                        />
                        <Button
                          variant="secondary"
                          onClick={handleSetSecret}
                        >
                          Set secret
                        </Button>
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '0.75rem',
                        }}
                      >
                        <Button variant="ghost" onClick={handleRevealSecret}>
                          Reveal secret (authorized roles)
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={handleDebugRevealSecret}
                        >
                          Debug reveal
                        </Button>
                      </div>
                      {revealedSecret !== null && (
                        <Text size="xs" color="muted">
                          Known secret: {' '}
                          <span style={{ color: '#fbbf24' }}>{revealedSecret}</span>
                        </Text>
                      )}
                      {latestGuessWasCorrect !== null && (
                        <Text
                          size="xs"
                          style={{
                            color: latestGuessWasCorrect ? '#34d399' : '#f87171',
                          }}
                        >
                          Latest guess:{' '}
                          {latestGuessWasCorrect ? 'correct 🎉' : 'incorrect'}
                        </Text>
                      )}
                      {showPromptEditor && (
                        <div
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.35rem',
                          }}
                        >
                          <Text size="sm" color="muted">
                            Custom assistant prompt
                          </Text>
                          <textarea
                            value={llmPrompt}
                            onChange={(event) => setLlmPrompt(event.target.value)}
                            rows={3}
                            style={{
                              width: '100%',
                              background: 'rgba(15, 23, 42, 0.6)',
                              color: '#e5e7eb',
                              border: '1px solid rgba(148, 163, 184, 0.2)',
                              borderRadius: '8px',
                              padding: '0.6rem',
                              fontSize: '0.9rem',
                              resize: 'vertical',
                            }}
                          />
                          <Text size="xs" color="muted">
                            The secret is automatically appended to the prompt before generation.
                          </Text>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>

              {showEventsCard && (
                <Card variant="rounded">
                  <CardHeader>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        width: '100%',
                        gap: '0.5rem',
                      }}
                    >
                      <CardTitle style={{ margin: 0 }}>Node Event Stream</CardTitle>
                      <Button
                        variant="ghost"
                        onClick={() =>
                          setIsEventPanelCollapsed(
                            (currentCollapsed) => !currentCollapsed,
                          )
                        }
                        style={{ paddingInline: '0.5rem' }}
                      >
                        {isEventPanelCollapsed ? 'Expand' : 'Collapse'}
                      </Button>
                    </div>
                  </CardHeader>
                  {!isEventPanelCollapsed && (
                    <CardContent
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '1rem',
                      }}
                    >
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.75rem',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '0.75rem',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.35rem',
                          flex: '1 1 320px',
                        }}
                      >
                        <Text size="sm" color="muted">
                          Status:{' '}
                          {eventStreamStatus === 'idle' && 'Idle'}
                          {eventStreamStatus === 'connecting' && 'Connecting…'}
                          {eventStreamStatus === 'connected' && 'Connected'}
                          {eventStreamStatus === 'error' &&
                            'Connection error (retrying)'}
                        </Text>
                        <Text size="xs" color="muted">
                          Subscribed contexts:{' '}
                          {contextIds.length > 0
                            ? contextIds.join(', ')
                            : 'none'}
                        </Text>
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <Button
                          variant="secondary"
                          onClick={() => setEventLog([])}
                          disabled={eventLog.length === 0}
                        >
                          Clear events
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setEventLog([]);
                            fetchSubscriptionContexts();
                          }}
                        >
                          Refresh contexts
                        </Button>
                      </div>
                    </div>
                    <Text size="xs" color="muted">
                      Events received via websocket from node {connectionTarget}.
                    </Text>
                  </div>
                  <div
                    style={{
                      maxHeight: '260px',
                      overflowY: 'auto',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.75rem',
                      background: 'rgba(15, 23, 42, 0.5)',
                      border: '1px solid rgba(148, 163, 184, 0.12)',
                      borderRadius: '10px',
                      padding: '0.75rem',
                    }}
                  >
                    {eventLog.length === 0 ? (
                      <Text size="sm" color="muted">
                        No events received yet.
                      </Text>
                    ) : (
                      eventLog.map((entry) => {
                        const metadata =
                          entry.metadata.length > 0
                            ? entry.metadata
                            : extractMessageMetadata(
                                entry.event ?? entry.parsed ?? entry.raw,
                              );
                        return (
                          <EventRow
                            key={entry.id}
                            entry={entry}
                            metadata={metadata}
                            isGenerating={isGenerating}
                            onGenerate={handleGenerateFromEvent}
                          />
                        );
                      })
                    )}
                  </div>
                    </CardContent>
                  )}
                </Card>
              )}

              {showConversationCard && (
                <Card
                  variant="rounded"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                  }}
                >
                  <CardHeader>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        width: '100%',
                        gap: '0.5rem',
                      }}
                    >
                      <CardTitle style={{ margin: 0 }}>Conversation</CardTitle>
                      <Button
                        variant="ghost"
                        onClick={loadHistory}
                        disabled={isLoadingHistory}
                      >
                        {isLoadingHistory ? 'Refreshing…' : 'Refresh chat'}
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '1rem',
                      paddingRight: '0.5rem',
                      minHeight: 0,
                    }}
                  >
                    <div
                      style={{
                        maxHeight: '60vh',
                        overflowY: 'auto',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '1rem',
                      }}
                    >
                      {messages.length === 0 ? (
                        <Text size="sm" color="muted">
                          Start the game by sending a question.
                        </Text>
                      ) : (
                        messages.map((message) => (
                          <MessageBubble key={message.id} message={message} />
                        ))
                      )}
                      <div ref={messagesEndRef} />
                    </div>
                  </CardContent>
                </Card>
              )}

              {showSendCard && (
                <Card variant="rounded">
                  <CardHeader>
                    <CardTitle>Send a message</CardTitle>
                  </CardHeader>
                  <CardContent
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '1rem',
                    }}
                  >
                    <textarea
                      value={input}
                      onChange={(event) => setInput(event.target.value)}
                      rows={4}
                      placeholder="Write your message...
Only the current player can act"
                      style={{
                        width: '100%',
                        background: 'rgba(15, 23, 42, 0.6)',
                        color: '#e5e7eb',
                        border: '1px solid rgba(148, 163, 184, 0.2)',
                        borderRadius: '8px',
                        padding: '0.75rem',
                        fontSize: '0.95rem',
                        resize: 'vertical',
                        whiteSpace: 'pre-line',
                      }}
                    />
                    {stageKey === 'waitingforanswer' && (
                      <Text size="xs" color="muted">
                        Player two answers using “Trigger LLM” only.
                      </Text>
                    )}
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'flex-end',
                        gap: '1rem',
                      }}
                    >
                      <Button
                        variant="primary"
                        onClick={handleSendMessage}
                        disabled={
                          isGenerating ||
                          input.trim().length === 0 ||
                          stageKey === 'waitingforanswer'
                        }
                      >
                        {isGenerating ? 'Generating…' : 'Send'}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          </GridItem>
        </Grid>
      </div>
    </>
  );
}

function MessageBubble({
  message,
}: {
  message: ConversationMessage;
}): JSX.Element {
  const isAssistant = message.role === 'assistant';
  return (
    <div
      style={{
        alignSelf: isAssistant ? 'flex-start' : 'flex-end',
        maxWidth: '75%',
        background: isAssistant
          ? 'rgba(79, 70, 229, 0.15)'
          : 'rgba(34, 197, 94, 0.2)',
        border: '1px solid rgba(148, 163, 184, 0.1)',
        borderRadius: '12px',
        padding: '0.75rem 1rem',
        boxShadow: '0 8px 16px -12px rgba(15, 23, 42, 0.8)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.35rem',
      }}
    >
      <Text size="xs" color="muted" style={{ fontSize: '0.7rem' }}>
        {message.sender} · {new Date(message.timestamp).toLocaleTimeString()}
      </Text>
      <Text
        size="sm"
        style={{ whiteSpace: 'pre-wrap', color: '#e5e7eb' }}
      >
        {message.content}
      </Text>
    </div>
  );
}

function extractAssistantContent(
  completion: webllm.types.ChatCompletion,
): string | null {
  const choice = completion.choices?.[0];
  if (!choice) {
    return null;
  }

  const content = choice.message?.content;
  if (!content) {
    return null;
  }

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => ('text' in part ? part.text : ''))
      .join('')
      .trim();
  }

  return null;
}

function sanitiseRole(role: string): ConversationRole {
  const normalised = role.trim().toLowerCase();
  if (normalised === 'player_two') {
    return 'assistant';
  }
  if (normalised === 'player_one') {
    return 'user';
  }
  if (normalised === 'assistant' || normalised === 'system') {
    return normalised;
  }
  return 'user';
}

function extractStageName(stage: unknown): string | null {
  if (!stage) {
    return null;
  }
  if (typeof stage === 'string') {
    return stage;
  }
  if (typeof stage === 'object') {
    const record = stage as Record<string, unknown>;
    if ('name' in record && typeof record.name === 'string') {
      return record.name;
    }
    const keys = Object.keys(record);
    if (keys.length > 0 && typeof keys[0] === 'string') {
      return keys[0];
    }
  }
  return null;
}

function canonicalStageKey(stageName: string): string {
  return stageName.replace(/[_\s]+/g, '').toLowerCase();
}

function upsertMessage(
  list: ConversationMessage[],
  incoming: ConversationMessage,
): ConversationMessage[] {
  const existingIndex = list.findIndex((message) => message.id === incoming.id);
  if (existingIndex === -1) {
    return [...list, incoming];
  }

  const next = [...list];
  next[existingIndex] = incoming;
  return next;
}

function removeMessageById(
  list: ConversationMessage[],
  id: string,
): ConversationMessage[] {
  if (!list.some((message) => message.id === id)) {
    return list;
  }

  return list.filter((message) => message.id !== id);
}

function extractStoredMessageKey(messageId: string): string {
  return messageId;
}

function decodeByteArray(data: unknown): unknown {
  if (Array.isArray(data) && data.every((value) => typeof value === 'number')) {
    try {
      const decodedString = new TextDecoder().decode(new Uint8Array(data));
      try {
        return JSON.parse(decodedString);
      } catch (_error) {
        return decodedString;
      }
    } catch (_error) {
      return data;
    }
  }

  return data;
}

function normaliseEventPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const record = payload as Record<string, unknown>;
  if (record.type === 'ExecutionEvent' && record.data) {
    const data = record.data as Record<string, unknown>;
    const events = Array.isArray(data.events) ? data.events : [];
    const decodedEvents = events.map((eventEntry) => {
      if (!eventEntry || typeof eventEntry !== 'object') {
        return eventEntry;
      }
      const eventRecord = eventEntry as Record<string, unknown>;
      return {
        ...eventRecord,
        data: decodeByteArray(eventRecord.data),
      };
    });

    return {
      ...record,
      data: {
        ...data,
        events: decodedEvents,
      },
    };
  }

  return payload;
}

function extractMessageMetadata(
  event: unknown,
): EventMessageMetadata[] {
  if (!event || typeof event !== 'object') {
    return [];
  }

  const record = event as Record<string, unknown>;
  const rawEvents = (() => {
    if (record.type === 'ExecutionEvent' && record.data) {
      const data = record.data as { events?: unknown[] };
      return Array.isArray(data.events) ? data.events : [];
    }
    if (record.type === 'StateMutation' && record.data) {
      const data = record.data as { events?: unknown[] };
      return Array.isArray(data.events) ? data.events : [];
    }
    return [];
  })();

  return rawEvents
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const eventRecord = item as Record<string, unknown>;
      if ((eventRecord.event ?? eventRecord.name) !== 'MessageAdded') {
        return null;
      }

      const decoded = decodeByteArray(eventRecord.data);
      if (!decoded || typeof decoded !== 'object') {
        return null;
      }
      const payload = decoded as Record<string, unknown>;
      const metadata: EventMessageMetadata = {
        id: Number(payload.id ?? payload.messageId ?? payload.message_id ?? -1),
        role: String(payload.role ?? ''),
        sender: String(payload.sender ?? ''),
        content: typeof payload.content === 'string' ? payload.content : null,
        timestampMs: typeof payload.timestamp_ms === 'number'
          ? payload.timestamp_ms
          : null,
      };
      return metadata;
    })
    .filter((entry): entry is EventMessageMetadata =>
      !!entry && Number.isFinite(entry.id) && entry.id >= 0,
    );
}

function EventRow({
  entry,
  metadata,
  onGenerate,
  isGenerating,
}: {
  entry: StreamEventEntry;
  metadata: EventMessageMetadata[];
  onGenerate?: (entry: StreamEventEntry) => void;
  isGenerating: boolean;
}): JSX.Element {
  const { name, parsed, raw, timestamp } = entry;
  const isStateMutation =
    entry.event &&
    typeof entry.event === 'object' &&
    (entry.event as { type?: unknown }).type === 'StateMutation';
  const canTriggerGeneration =
    isStateMutation ||
    metadata.some((meta) => sanitiseRole(meta.role) === 'user');

  let body: JSX.Element;
  if (parsed && typeof parsed === 'object') {
    body = (
      <pre
        style={{
          fontSize: '0.75rem',
          whiteSpace: 'pre-wrap',
          margin: 0,
          color: '#e5e7eb',
          fontFamily:
            'ui-monospace, SFMono-Regular, Consolas, Liberation Mono, Menlo, monospace',
        }}
      >
        {JSON.stringify(parsed, null, 2)}
      </pre>
    );
  } else if (typeof parsed === 'string') {
    body = (
      <Text size="sm" style={{ color: '#e5e7eb', whiteSpace: 'pre-wrap' }}>
        {parsed}
      </Text>
    );
  } else if (raw) {
    body = (
      <Text size="sm" style={{ color: '#e5e7eb', whiteSpace: 'pre-wrap' }}>
        {raw}
      </Text>
    );
  } else {
    body = (
      <Text size="sm" style={{ color: '#e5e7eb' }}>
        (empty payload)
      </Text>
    );
  }

  return (
    <div
      style={{
        border: '1px solid rgba(148, 163, 184, 0.18)',
        borderRadius: '8px',
        padding: '0.65rem 0.75rem',
        background: 'rgba(59, 130, 246, 0.08)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.4rem',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '0.75rem',
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            flexWrap: 'wrap',
          }}
        >
          <Text
            size="sm"
            style={{
              color: '#93c5fd',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              fontSize: '0.7rem',
            }}
          >
            {name}
          </Text>
          {canTriggerGeneration && onGenerate && (
            <Button
              variant="secondary"
              size="small"
              onClick={() => onGenerate(entry)}
              disabled={isGenerating}
              style={{ fontSize: '0.7rem', paddingInline: '0.75rem' }}
            >
              Trigger LLM
            </Button>
          )}
        </div>
        <Text size="xs" color="muted">
          {new Date(timestamp).toLocaleTimeString()}
        </Text>
      </div>
      {body}
    </div>
  );
}
