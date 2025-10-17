use calimero_sdk::app;
use calimero_sdk::borsh::{BorshDeserialize, BorshSerialize};
use calimero_sdk::serde::Serialize;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize)]
#[borsh(crate = "calimero_sdk::borsh")]
#[serde(crate = "calimero_sdk::serde", rename_all = "snake_case")]
pub enum GamePhase {
    Setup,
    InProgress,
    Finished,
}

impl GamePhase {
    fn as_str(self) -> &'static str {
        match self {
            GamePhase::Setup => "setup",
            GamePhase::InProgress => "in_progress",
            GamePhase::Finished => "finished",
        }
    }
}

impl core::fmt::Display for GamePhase {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, BorshSerialize, BorshDeserialize)]
#[borsh(crate = "calimero_sdk::borsh")]
struct PlayerEntry {
    id: String,
    number: Option<i64>,
    discovered: bool,
}

impl PlayerEntry {
    fn new(id: String, number: i64) -> Self {
        Self {
            id,
            number: Some(number),
            discovered: false,
        }
    }

    fn number_submitted(&self) -> bool {
        self.number.is_some()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(crate = "calimero_sdk::serde")]
pub struct PlayerView {
    pub id: String,
    pub number: Option<i64>,
    pub number_submitted: bool,
    pub discovered: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(crate = "calimero_sdk::serde")]
pub struct GameView {
    pub phase: GamePhase,
    pub current_turn: Option<String>,
    pub winner: Option<String>,
    pub players: Vec<PlayerView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(crate = "calimero_sdk::serde")]
pub struct DiscoverOutcome {
    pub opponent_number: i64,
    pub game: GameView,
}

#[app::state(emits = for<'a> Event<'a>)]
#[derive(Debug, BorshSerialize, BorshDeserialize)]
#[borsh(crate = "calimero_sdk::borsh")]
pub struct ScripsicllaGame {
    players: Vec<PlayerEntry>,
    phase: GamePhase,
    current_turn_index: Option<u8>,
    winner: Option<String>,
}

#[app::event]
pub enum Event<'a> {
    PlayerRegistered { player_id: &'a str },
    NumberSubmitted { player_id: &'a str },
    NumberDiscovered {
        player_id: &'a str,
        target_id: &'a str,
        value: i64,
    },
    TurnChanged { player_id: Option<&'a str> },
    GameFinished { winner: Option<&'a str> },
}

#[derive(Debug, Error, Serialize)]
#[serde(crate = "calimero_sdk::serde")]
#[serde(tag = "kind", content = "data")]
pub enum Error {
    #[error("game already has two players")]
    GameFull,
    #[error("player already submitted a number")]
    NumberAlreadySubmitted,
    #[error("player not part of the game: {0}")]
    PlayerUnknown(String),
    #[error("game requires both players to be ready")]
    NotEnoughPlayers,
    #[error("cannot submit numbers during {0}")]
    InvalidPhase(String),
    #[error("game already finished")]
    GameFinished,
    #[error("wait for your turn: {0}")]
    NotYourTurn(String),
    #[error("number already discovered for player: {0}")]
    AlreadyDiscovered(String),
}

#[app::logic]
impl ScripsicllaGame {
    #[app::init]
    pub fn init() -> ScripsicllaGame {
        ScripsicllaGame {
            players: Vec::new(),
            phase: GamePhase::Setup,
            current_turn_index: None,
            winner: None,
        }
    }

    pub fn submit_number(&mut self, player_id: String, number: i64) -> app::Result<GameView> {
        app::log!(
            "Player {:?} attempting to submit number {:?}",
            player_id,
            number
        );

        if self.phase != GamePhase::Setup {
            app::bail!(Error::InvalidPhase(self.phase.to_string()));
        }

        let maybe_idx = self.find_player_index(&player_id);
        let idx = if let Some(idx) = maybe_idx {
            let entry = self
                .players
                .get_mut(idx)
                .expect("player index should be in range");
            if entry.number_submitted() {
                app::bail!(Error::NumberAlreadySubmitted);
            }
            entry.number = Some(number);
            idx
        } else {
            if self.players.len() >= 2 {
                app::bail!(Error::GameFull);
            }
            let entry = PlayerEntry::new(player_id.clone(), number);
            self.players.push(entry);
            let idx = self.players.len() - 1;
            app::emit!(Event::PlayerRegistered {
                player_id: &player_id
            });
            idx
        };

        app::emit!(Event::NumberSubmitted {
            player_id: &self.players[idx].id
        });

        if self.players_ready() {
            self.phase = GamePhase::InProgress;
            if self.current_turn_index.is_none() {
                self.current_turn_index = Some(0);
                if let Some(current) = self.current_player_id() {
                    app::emit!(Event::TurnChanged {
                        player_id: Some(current),
                    });
                }
            }
        }

        Ok(self.view())
    }

    pub fn discover_number(&mut self, player_id: String) -> app::Result<DiscoverOutcome> {
        app::log!("Player {:?} attempts to discover", player_id);

        match self.phase {
            GamePhase::Setup => app::bail!(Error::NotEnoughPlayers),
            GamePhase::Finished => app::bail!(Error::GameFinished),
            GamePhase::InProgress => {}
        }

        if !self.players_ready() {
            app::bail!(Error::NotEnoughPlayers);
        }

        let player_index = self
            .find_player_index(&player_id)
            .ok_or_else(|| Error::PlayerUnknown(player_id.clone()))?;

        let current_turn_index = self
            .current_turn_index
            .map(usize::from)
            .expect("current turn must be set while game is in progress");

        if player_index != current_turn_index {
            let current_id = &self.players[current_turn_index].id;
            app::bail!(Error::NotYourTurn(current_id.clone()));
        }

        let opponent_index = Self::opponent_index(player_index);
        let (opponent_id, opponent_number) = {
            let opponent_entry = self
                .players
                .get(opponent_index)
                .expect("opponent must exist");
            let opponent_number = opponent_entry
                .number
                .expect("opponent must have submitted a number");
            (opponent_entry.id.clone(), opponent_number)
        };

        let player_id_for_event = {
            let player_entry = self
                .players
                .get_mut(player_index)
                .expect("player index must be valid");

            if player_entry.discovered {
                app::bail!(Error::AlreadyDiscovered(player_entry.id.clone()));
            }

            player_entry.discovered = true;
            player_entry.id.clone()
        };

        app::emit!(Event::NumberDiscovered {
            player_id: &player_id_for_event,
            target_id: &opponent_id,
            value: opponent_number,
        });

        if self.players[opponent_index].discovered {
            self.phase = GamePhase::Finished;
            self.current_turn_index = None;
            self.winner = self.determine_winner();
            app::emit!(Event::TurnChanged { player_id: None });
            app::emit!(Event::GameFinished {
                winner: self.winner.as_deref(),
            });
        } else {
            self.current_turn_index =
                Some(u8::try_from(opponent_index).expect("only two players are supported"));
            if let Some(current) = self.current_player_id() {
                app::emit!(Event::TurnChanged {
                    player_id: Some(current),
                });
            }
        }

        Ok(DiscoverOutcome {
            opponent_number,
            game: self.view(),
        })
    }

    pub fn game_state(&self) -> app::Result<GameView> {
        app::log!("Fetching game state");
        Ok(self.view())
    }

    fn players_ready(&self) -> bool {
        self.players.len() == 2 && self.players.iter().all(PlayerEntry::number_submitted)
    }

    fn find_player_index(&self, player_id: &str) -> Option<usize> {
        self.players
            .iter()
            .position(|player| player.id == player_id)
    }

    fn opponent_index(player_index: usize) -> usize {
        match player_index {
            0 => 1,
            1 => 0,
            _ => panic!("only two players are supported"),
        }
    }

    fn current_player_id(&self) -> Option<&str> {
        self.current_turn_index
            .map(usize::from)
            .and_then(|idx| self.players.get(idx))
            .map(|player| player.id.as_str())
    }

    fn determine_winner(&self) -> Option<String> {
        if self.players.len() < 2 {
            return None;
        }

        let first = &self.players[0];
        let second = &self.players[1];

        let Some(first_number) = first.number else {
            return None;
        };
        let Some(second_number) = second.number else {
            return None;
        };

        if first_number > second_number {
            Some(first.id.clone())
        } else if second_number > first_number {
            Some(second.id.clone())
        } else {
            None
        }
    }

    fn view(&self) -> GameView {
        let phase = self.phase;
        let current_turn = self.current_player_id().map(str::to_owned);
        let winner = self.winner.clone();
        let players = self
            .players
            .iter()
            .map(|player| PlayerView {
                id: player.id.clone(),
                number: if player.discovered || phase == GamePhase::Finished {
                    player.number
                } else {
                    None
                },
                number_submitted: player.number_submitted(),
                discovered: player.discovered,
            })
            .collect();

        GameView {
            phase,
            current_turn,
            winner,
            players,
        }
    }
}
