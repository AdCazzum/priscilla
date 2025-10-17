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
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const connectionTarget = useMemo(() => {
    if (!appUrl) {
      return 'http://node1.127.0.0.1.nip.io';
    }
    return appUrl;
  }, [appUrl]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/');
    }
  }, [isAuthenticated, navigate]);

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
        return {
          id: `stored-${stored.id}`,
          role: sanitiseRole(stored.role),
          content: stored.content,
          sender: stored.sender,
          timestamp: stored.timestamp_ms,
        };
      } catch (error) {
        console.error('Failed to persist message', error);
        show({
          title: 'Failed to persist message to Calimero',
          variant: 'error',
        });
        return null;
      }
    },
    [apiClient, show],
  );

  const handleSendMessage = useCallback(async () => {
    const trimmed = input.trim();
    if (
      !trimmed ||
      !apiClient ||
      !engine ||
      isGenerating ||
      !engineReady
    ) {
      return;
    }

    setIsGenerating(true);
    setInput('');

    const userMessage: Omit<ConversationMessage, 'id'> = {
      role: 'user',
      content: trimmed,
      sender: displayName.trim() || 'you',
      timestamp: Date.now(),
    };

    const persistedUser = await persistMessage(userMessage);
    const updatedHistory = persistedUser
      ? [...messages, persistedUser]
      : [...messages, { ...userMessage, id: `local-${Date.now()}` }];

    setMessages(updatedHistory);

    try {
      const llmMessages = buildLlmContext(updatedHistory);
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
      const finalHistory = persistedAssistant
        ? [...updatedHistory, persistedAssistant]
        : [
            ...updatedHistory,
            { ...assistantMessage, id: `local-${Date.now()}` },
          ];
      setMessages(finalHistory);
    } catch (error) {
      console.error('Failed to generate assistant response', error);
      show({
        title: 'The assistant failed to respond',
        variant: 'error',
      });
    } finally {
      setIsGenerating(false);
    }
  }, [
    apiClient,
    buildLlmContext,
    displayName,
    engine,
    engineReady,
    input,
    isGenerating,
    messages,
    persistMessage,
    show,
  ]);

  const handleClearChat = useCallback(async () => {
    if (!apiClient) return;
    try {
      await apiClient.clearHistory();
      setMessages([]);
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
