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
  ChatMessage as StoredMessage,
  ChatInfo,
} from '../../api/AbiClient';

type ConversationRole = 'system' | 'user' | 'assistant';

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

export default function HomePage(): JSX.Element {
  const navigate = useNavigate();
  const { isAuthenticated, logout, app, appUrl } = useCalimero();
  const { show } = useToast();

  const [displayName, setDisplayName] = useState<string>('you');
  const [input, setInput] = useState<string>('');
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [info, setInfo] = useState<ChatInfo | null>(null);
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
      const [history, metadata] = await Promise.all([
        apiClient.messages({ offset: 0, limit: MAX_HISTORY }),
        apiClient.info(),
      ]);
      setMessages(normaliseStoredMessages(history));
      setInfo(metadata);
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
    (history: ConversationMessage[]): webllm.ChatCompletionMessageParam[] => {
      return history.map((message) => ({
        role: message.role,
        content: message.content,
      }));
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

  const persistMessage = useCallback(
    async (
      payload: Omit<ConversationMessage, 'id'>,
    ): Promise<ConversationMessage | null> => {
      if (!apiClient) return null;
      try {
        const stored = await apiClient.sendMessage({
          sender: payload.sender,
          role: payload.role,
          content: payload.content,
        });
        return normaliseStoredMessage(stored);
      } catch (error) {
        console.error('Failed to persist message', error);
        show({
          title: 'Failed to persist message to Calimero',
          variant: 'error',
        });
        return null;
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
      if (respondedMessageIdsRef.current.has(triggerMessage.id)) {
        return;
      }

      respondedMessageIdsRef.current.add(triggerMessage.id);
      setIsGenerating(true);

      const placeholderId = `assistant-pending-${triggerMessage.id}`;
      pendingAssistantRef.current.set(triggerMessage.id, placeholderId);

      const placeholder: ConversationMessage = {
        id: placeholderId,
        role: 'assistant',
        content: 'Generating response…',
        sender: 'assistant',
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
        const llmMessages = buildLlmContext(history);
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

        const assistantMessage: Omit<ConversationMessage, 'id'> = {
          role: 'assistant',
          content: assistantText,
          sender: 'assistant',
          timestamp: Date.now(),
        };

        const persistedAssistant = await persistMessage(assistantMessage);
        const conversationAssistant =
          persistedAssistant ?? {
            ...assistantMessage,
            id: `local-${Date.now()}`,
          };
        pendingAssistantRef.current.delete(triggerMessage.id);

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
      appendStreamEvent,
      buildLlmContext,
      engine,
      engineReady,
      persistMessage,
      show,
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

      const eventMessages = extractMessageMetadata(event);
      if (eventMessages.length > 0) {
        void processEventMetadata(eventMessages);
      }
    },
    [appendStreamEvent, extractMessageMetadata, processEventMetadata],
  );

  const handleGenerateFromEvent = useCallback(
    async (entry: StreamEventEntry) => {
      const source = entry.event ?? entry.parsed ?? entry.raw;
      if (!source) {
        show({
          title: 'Evento senza payload da processare',
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
          title: 'Nessun messaggio utente da processare',
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

  const handleSendMessage = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || !apiClient) {
      return;
    }

    setInput('');

    const userMessage: Omit<ConversationMessage, 'id'> = {
      role: 'user',
      content: trimmed,
      sender: displayName.trim() || 'you',
      timestamp: Date.now(),
    };

    const persistedUser = await persistMessage(userMessage);
    const conversationMessage =
      persistedUser ?? { ...userMessage, id: `local-${Date.now()}` };

    const nextMessages = upsertMessage(
      messagesRef.current,
      conversationMessage,
    );
    messagesRef.current = nextMessages;
    setMessages(nextMessages);
  }, [apiClient, displayName, input, persistMessage]);

  const handleClearChat = useCallback(async () => {
    if (!apiClient) return;
    try {
      await apiClient.clearHistory();
      setMessages([]);
      messagesRef.current = [];
      respondedMessageIdsRef.current.clear();
      pendingAssistantRef.current.clear();
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

  return (
    <>
      <MeroNavbar variant="elevated" size="md">
        <NavbarBrand text={translations.auth.title} />
        <NavbarMenu align="center">{connectionBadge}</NavbarMenu>
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
                    <div style={{ flex: '1 1 220px' }}>
                      <Text size="sm" color="muted">
                        Display name
                      </Text>
                      <Input
                        value={displayName}
                        onChange={(event) =>
                          setDisplayName(event.target.value)
                        }
                        placeholder="Your name"
                      />
                    </div>
                    <div style={{ flex: '1 1 220px' }}>
                      <Text size="sm" color="muted">
                        Stored messages
                      </Text>
                      <Text
                        size="lg"
                        style={{ fontWeight: 600, color: '#e5e7eb' }}
                      >
                        {info
                          ? `${info.total_messages}/${info.max_messages}`
                          : '—'}
                      </Text>
                    </div>
                    <div style={{ flex: '1 1 220px' }}>
                      <Text size="sm" color="muted">
                        Engine
                      </Text>
                      <Text
                        size="lg"
                        style={{ fontWeight: 600, color: '#e5e7eb' }}
                      >
                        {MODEL_NAME}
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
                    <Button variant="error" onClick={handleClearChat}>
                      Clear history
                    </Button>
                  </div>
                </CardContent>
              </Card>

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
                          Contesti sottoscritti:{' '}
                          {contextIds.length > 0
                            ? contextIds.join(', ')
                            : 'nessuno'}
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
                      Eventi ricevuti via websocket dal nodo {connectionTarget}.
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
                        Nessun evento ricevuto finora.
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

              <Card
                variant="rounded"
                style={{
                  height: '60vh',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <CardHeader>
                  <CardTitle>Conversation</CardTitle>
                </CardHeader>
                <CardContent
                  style={{
                    flex: 1,
                    overflowY: 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '1rem',
                    paddingRight: '0.5rem',
                  }}
                >
                  {messages.length === 0 ? (
                    <Text size="sm" color="muted">
                      Start the conversation by sending a message.
                    </Text>
                  ) : (
                    messages.map((message) => (
                      <MessageBubble key={message.id} message={message} />
                    ))
                  )}
                  <div ref={messagesEndRef} />
                </CardContent>
              </Card>

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
                    placeholder="Ask the assistant anything…"
                    style={{
                      width: '100%',
                      background: 'rgba(15, 23, 42, 0.6)',
                      color: '#e5e7eb',
                      border: '1px solid rgba(148, 163, 184, 0.2)',
                      borderRadius: '8px',
                      padding: '0.75rem',
                      fontSize: '0.95rem',
                      resize: 'vertical',
                    }}
                  />
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
                        !engineReady ||
                        isGenerating ||
                        input.trim().length === 0
                      }
                    >
                      {isGenerating ? 'Generating…' : 'Send'}
                    </Button>
                  </div>
                </CardContent>
              </Card>
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
  if (normalised === 'assistant' || normalised === 'system') {
    return normalised;
  }
  return 'user';
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
