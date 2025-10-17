import React, { useEffect, useState, useCallback } from 'react';
import {
  Button,
  Input,
  Navbar as MeroNavbar,
  NavbarBrand,
  NavbarMenu,
  NavbarItem,
  Grid,
  GridItem,
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  Menu,
  MenuItem,
  MenuGroup,
  useToast,
  CopyToClipboard,
  Text,
} from '@calimero-network/mero-ui';
import translations from '../../constants/en.global.json';
import { useNavigate } from 'react-router-dom';
import {
  useCalimero,
  CalimeroConnectButton,
  ConnectionType,
} from '@calimero-network/calimero-client';
import { createGameClient, AbiClient } from '../../features/kv/api';
import type { GameView, PlayerView } from '../../api/AbiClient';

export default function HomePage() {
  const navigate = useNavigate();
  const { isAuthenticated, logout, app, appUrl } = useCalimero();
  const { show } = useToast();
  const [playerId, setPlayerId] = useState<string>('');
  const [secretNumber, setSecretNumber] = useState<string>('');
  const [gameState, setGameState] = useState<GameView | null>(null);
  const [isLoadingState, setIsLoadingState] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [isDiscovering, setIsDiscovering] = useState<boolean>(false);
  const [isResetting, setIsResetting] = useState<boolean>(false);
  const [api, setApi] = useState<AbiClient | null>(null);
  const [currentContext, setCurrentContext] = useState<{
    applicationId: string;
    contextId: string;
    nodeUrl: string;
  } | null>(null);

  const decodeCalimeroError = useCallback(
    (err: unknown, fallback: string): string => {
      if (!(err instanceof Error)) {
        return fallback;
      }

      const asciiMatch = err.message.match(/\[(\s*\d+(?:\s*,\s*\d+)*)\]/);
      if (asciiMatch) {
        const byteValues = asciiMatch[1]
          .split(',')
          .map((value) => parseInt(value.trim(), 10))
          .filter((value) => Number.isFinite(value));

        if (byteValues.length > 0) {
          try {
            const jsonPayload = String.fromCharCode(...byteValues);
            const parsed = JSON.parse(jsonPayload) as {
              kind?: string;
              data?: unknown;
            };

            if (parsed && typeof parsed.kind === 'string') {
              switch (parsed.kind) {
                case 'GameFull':
                  return 'Both player slots are already filled.';
                case 'NumberAlreadySubmitted':
                  return 'This player already submitted a number.';
                case 'PlayerUnknown':
                  return `Unknown player id: ${parsed.data ?? 'N/A'}.`;
                case 'NotEnoughPlayers':
                  return 'Both players must submit numbers before discovering.';
                case 'InvalidPhase':
                  return `Action not allowed during phase: ${parsed.data ?? 'unknown'}.`;
                case 'GameFinished':
                  return 'The game already finished.';
                case 'NotYourTurn':
                  return `Wait for your turn. Current player: ${parsed.data ?? 'unknown'}.`;
                case 'AlreadyDiscovered':
                  return 'This player already discovered the opponent number.';
                case 'GameInProgress':
                  return 'Finish the current round before starting a new game.';
                default:
                  break;
              }
            }

            return jsonPayload;
          } catch (parseError) {
            console.warn('Failed to parse Calimero error payload', parseError);
          }
        }
      }

      return err.message || fallback;
    },
    [],
  );

  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/');
    }
  }, [isAuthenticated, navigate]);

  // Create API client when app is available
  useEffect(() => {
    if (!app) return;

    const initializeApi = async () => {
      try {
        const client = await createGameClient(app);
        setApi(client);

        // Get context information
        const contexts = await app.fetchContexts();
        if (contexts.length > 0) {
          const context = contexts[0];
          setCurrentContext({
            applicationId: context.applicationId,
            contextId: context.contextId,
            nodeUrl: appUrl || 'http://node1.127.0.0.1.nip.io', // Fallback to hardcoded URL
          });
        }
      } catch (error) {
        console.error('Failed to create API client:', error);
        window.alert('Failed to initialize API client');
      }
    };

    initializeApi();
  }, [app]);

  const formatPhase = useCallback((phase: GameView['phase'] | undefined) => {
    if (!phase) return '—';
    if (typeof phase === 'string') return phase;
    if (typeof phase === 'object' && 'name' in phase && phase.name) {
      return phase.name;
    }
    return String(phase);
  }, []);

  const refreshGameState = useCallback(async () => {
    if (!api) return;
    setIsLoadingState(true);
    try {
      const state = await api.gameState();
      setGameState(state);
    } catch (error) {
      console.error('refreshGameState error:', error);
      show({
        title: decodeCalimeroError(error, translations.home.errors.stateFailed),
        variant: 'error',
      });
    } finally {
      setIsLoadingState(false);
    }
  }, [api, show, decodeCalimeroError]);

  const submitNumber = useCallback(async () => {
    if (!api) return;
    const trimmedId = playerId.trim();
    const parsedNumber = Number(secretNumber);

    if (!trimmedId) {
      show({
        title: 'Player ID is required',
        variant: 'error',
      });
      return;
    }

    if (!Number.isFinite(parsedNumber)) {
      show({
        title: 'Enter a valid number',
        variant: 'error',
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const updatedState = await api.submitNumber({
        player_id: trimmedId,
        number: parsedNumber,
      });
      setGameState(updatedState);
      show({
        title: translations.home.success.submit,
        variant: 'success',
      });
      setSecretNumber('');
    } catch (error) {
      console.error('submitNumber error:', error);
      show({
        title: decodeCalimeroError(error, translations.home.errors.submitFailed),
        variant: 'error',
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [api, playerId, secretNumber, show, decodeCalimeroError]);

  const discoverOpponent = useCallback(async () => {
    if (!api) return;
    const trimmedId = playerId.trim();

    if (!trimmedId) {
      show({
        title: 'Player ID is required',
        variant: 'error',
      });
      return;
    }

    setIsDiscovering(true);
    try {
      const outcome = await api.discoverNumber({ player_id: trimmedId });
      setGameState(outcome.game);
      show({
        title: `${translations.home.success.discover}: ${outcome.opponent_number}`,
        variant: 'success',
      });
    } catch (error) {
      console.error('discoverOpponent error:', error);
      show({
        title: decodeCalimeroError(error, translations.home.errors.discoverFailed),
        variant: 'error',
      });
    } finally {
      setIsDiscovering(false);
    }
  }, [api, playerId, show, decodeCalimeroError]);

  const startNewGame = useCallback(async () => {
    if (!api) return;

    setIsResetting(true);
    try {
      const state = await api.startNewGame();
      setGameState(state);
      setPlayerId('');
      setSecretNumber('');
      show({
        title: translations.home.success.reset,
        variant: 'success',
      });
    } catch (error) {
      console.error('startNewGame error:', error);
      show({
        title: decodeCalimeroError(error, translations.home.errors.resetFailed),
        variant: 'error',
      });
    } finally {
      setIsResetting(false);
    }
  }, [api, decodeCalimeroError, show]);

  useEffect(() => {
    if (isAuthenticated && api) {
      refreshGameState();
    }
  }, [isAuthenticated, api, refreshGameState]);

  const doLogout = useCallback(() => {
    logout();
    navigate('/');
  }, [logout, navigate]);

  const renderPlayer = useCallback((player: PlayerView) => {
      const numberDisplay =
        player.number !== null ? player.number : translations.home.numberHidden;
      return (
        <div
          key={player.id}
          style={{
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '8px',
            padding: '1rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            background: 'rgba(255, 255, 255, 0.02)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '0.75rem',
            }}
          >
            <Text
              size="md"
              style={{ fontFamily: 'monospace', color: '#e5e7eb' }}
            >
              {player.id}
            </Text>
            <div
              style={{
                display: 'flex',
                gap: '0.5rem',
                flexWrap: 'wrap',
              }}
            >
              <span
                style={{
                  backgroundColor: player.number_submitted
                    ? 'rgba(16, 185, 129, 0.2)'
                    : 'rgba(234, 179, 8, 0.2)',
                  color: player.number_submitted ? '#34d399' : '#facc15',
                  padding: '0.25rem 0.5rem',
                  borderRadius: '9999px',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                {player.number_submitted ? 'Submitted' : 'Pending'}
              </span>
              <span
                style={{
                  backgroundColor: player.discovered
                    ? 'rgba(59, 130, 246, 0.2)'
                    : 'rgba(148, 163, 184, 0.2)',
                  color: player.discovered ? '#93c5fd' : '#cbd5f5',
                  padding: '0.25rem 0.5rem',
                  borderRadius: '9999px',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                {player.discovered ? 'Discovered' : 'Hidden'}
              </span>
            </div>
          </div>
          <Text size="sm" color="muted">
            Secret: {numberDisplay}
          </Text>
        </div>
      );
    },
    [],
  );

  const formattedPhase = formatPhase(gameState?.phase);
  const isGameInProgress = formattedPhase === 'InProgress';

  return (
    <>
      <MeroNavbar variant="elevated" size="md">
        <NavbarBrand text={translations.auth.title} />
        <NavbarMenu align="center">
          {currentContext && (
            <div
              style={{
                display: 'flex',
                gap: '1.5rem',
                alignItems: 'center',
                fontSize: '0.875rem',
                color: '#9ca3af',
                flexWrap: 'wrap',
                justifyContent: 'center',
              }}
            >
              <div
                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
              >
                <Text size="sm" color="muted">
                  Node:
                </Text>
                <Text
                  size="sm"
                  style={{ fontFamily: 'monospace', color: '#e5e7eb' }}
                >
                  {currentContext.nodeUrl
                    .replace('http://', '')
                    .replace('https://', '')}
                </Text>
                <CopyToClipboard
                  text={currentContext.nodeUrl}
                  variant="icon"
                  size="small"
                  successMessage="Node URL copied!"
                />
              </div>
              <div
                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
              >
                <Text size="sm" color="muted">
                  App ID:
                </Text>
                <Text
                  size="sm"
                  style={{ fontFamily: 'monospace', color: '#e5e7eb' }}
                >
                  {currentContext.applicationId.slice(0, 8)}...
                  {currentContext.applicationId.slice(-8)}
                </Text>
                <CopyToClipboard
                  text={currentContext.applicationId}
                  variant="icon"
                  size="small"
                  successMessage="Application ID copied!"
                />
              </div>
              <div
                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
              >
                <Text size="sm" color="muted">
                  Context ID:
                </Text>
                <Text
                  size="sm"
                  style={{ fontFamily: 'monospace', color: '#e5e7eb' }}
                >
                  {currentContext.contextId.slice(0, 8)}...
                  {currentContext.contextId.slice(-8)}
                </Text>
                <CopyToClipboard
                  text={currentContext.contextId}
                  variant="icon"
                  size="small"
                  successMessage="Context ID copied!"
                />
              </div>
            </div>
          )}
        </NavbarMenu>
        <NavbarMenu align="right">
          {isAuthenticated ? (
            <Menu variant="compact" size="md">
              <MenuGroup>
                <MenuItem onClick={doLogout}>
                  {translations.home.logout}
                </MenuItem>
              </MenuGroup>
            </Menu>
          ) : (
            <NavbarItem>
              <CalimeroConnectButton
                connectionType={{
                  type: ConnectionType.Custom,
                  url: 'http://node1.127.0.0.1.nip.io',
                }}
              />
            </NavbarItem>
          )}
        </NavbarMenu>
      </MeroNavbar>
      <div
        style={{
          minHeight: '100vh',
          backgroundColor: '#111111',
          color: 'white',
        }}
      >
        <Grid
          columns={1}
          gap={32}
          maxWidth="100%"
          justify="center"
          align="center"
          style={{
            minHeight: '100vh',
            padding: '2rem',
          }}
        >
          <GridItem>
            <main
              style={{
                width: '100%',
                maxWidth: '1200px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <div style={{ maxWidth: '900px', width: '100%', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
                <Card variant="rounded">
                  <CardHeader>
                    <CardTitle>{translations.home.welcome}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Text size="md" style={{ color: '#9ca3af', marginBottom: '1rem' }}>
                      {translations.home.demoDescription}
                    </Text>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                        gap: '1rem',
                        width: '100%',
                      }}
                    >
                      <Card
                        variant="rounded"
                        style={{
                          border: '1px solid rgba(255,255,255,0.08)',
                          background: 'rgba(17, 24, 39, 0.6)',
                        }}
                      >
                        <CardContent>
                          <Text size="sm" color="muted">
                            {translations.home.phase}
                          </Text>
                          <Text size="lg" style={{ fontWeight: 600 }}>
                            {formattedPhase}
                          </Text>
                        </CardContent>
                      </Card>
                      <Card
                        variant="rounded"
                        style={{
                          border: '1px solid rgba(255,255,255,0.08)',
                          background: 'rgba(17, 24, 39, 0.6)',
                        }}
                      >
                        <CardContent>
                          <Text size="sm" color="muted">
                            {translations.home.currentTurn}
                          </Text>
                          <Text size="lg" style={{ fontWeight: 600 }}>
                            {gameState?.current_turn ?? '—'}
                          </Text>
                        </CardContent>
                      </Card>
                      <Card
                        variant="rounded"
                        style={{
                          border: '1px solid rgba(255,255,255,0.08)',
                          background: 'rgba(17, 24, 39, 0.6)',
                        }}
                      >
                        <CardContent>
                          <Text size="sm" color="muted">
                            {translations.home.winner}
                          </Text>
                          <Text size="lg" style={{ fontWeight: 600 }}>
                            {gameState?.winner ?? '—'}
                          </Text>
                        </CardContent>
                      </Card>
                    </div>
                    <div style={{ marginTop: '1.5rem' }}>
                      <Button
                        variant="secondary"
                        onClick={refreshGameState}
                        disabled={isLoadingState || !api}
                      >
                        {translations.home.refreshState}
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                <Card variant="rounded">
                  <CardHeader>
                    <CardTitle>{translations.home.submitSection}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        submitNumber();
                      }}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '1.25rem',
                      }}
                    >
                      <Input
                        type="text"
                        placeholder={translations.home.playerId}
                        value={playerId}
                        onChange={(e) => setPlayerId(e.target.value)}
                      />
                      <Input
                        type="number"
                        placeholder={translations.home.number}
                        value={secretNumber}
                        onChange={(e) => setSecretNumber(e.target.value)}
                      />
                      <Button
                        type="submit"
                        variant="success"
                        disabled={isSubmitting || !api}
                        style={{ minHeight: '3rem' }}
                      >
                        {isSubmitting
                          ? 'Submitting...'
                          : translations.home.submitNumber}
                      </Button>
                    </form>
                  </CardContent>
                </Card>

                <Card variant="rounded">
                  <CardHeader>
                    <CardTitle>{translations.home.discoverSection}</CardTitle>
                  </CardHeader>
                  <CardContent
                    style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
                  >
                    <Text size="sm" color="muted">
                      {translations.home.calimeroIntro}
                    </Text>
                    <Button
                      variant="primary"
                      onClick={discoverOpponent}
                      disabled={isDiscovering || !api}
                      style={{ minHeight: '3rem', maxWidth: '260px' }}
                    >
                      {isDiscovering
                        ? 'Revealing...'
                        : translations.home.discover}
                    </Button>
                  </CardContent>
                </Card>

                <Card variant="rounded">
                  <CardHeader>
                    <CardTitle>{translations.home.newGameSection}</CardTitle>
                  </CardHeader>
                  <CardContent
                    style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
                  >
                    <Text size="sm" color="muted">
                      {isGameInProgress
                        ? 'Complete the current round before starting another duel.'
                        : 'Reset the board so players can submit fresh secret numbers.'}
                    </Text>
                    <Button
                      variant="secondary"
                      onClick={startNewGame}
                      disabled={isResetting || !api || isGameInProgress}
                      style={{ minHeight: '3rem', maxWidth: '260px' }}
                    >
                      {isResetting
                        ? 'Resetting...'
                        : translations.home.startNewGame}
                    </Button>
                  </CardContent>
                </Card>

                <Card variant="rounded">
                  <CardHeader>
                    <CardTitle>{translations.home.players}</CardTitle>
                  </CardHeader>
                  <CardContent
                    style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
                  >
                    {gameState && gameState.players.length > 0 ? (
                      gameState.players.map((player) => renderPlayer(player))
                    ) : (
                      <Text
                        size="sm"
                        style={{
                          color: '#9ca3af',
                          textAlign: 'center',
                          padding: '1rem 0',
                        }}
                      >
                        {translations.home.noPlayers}
                      </Text>
                    )}
                  </CardContent>
                </Card>
              </div>
            </main>
          </GridItem>
        </Grid>
      </div>
    </>
  );
}
