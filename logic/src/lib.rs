use calimero_sdk::app;
use calimero_sdk::borsh::{BorshDeserialize, BorshSerialize};
use calimero_sdk::env;
use calimero_sdk::serde::{Deserialize, Serialize};
use thiserror::Error;

const MAX_NAME_LENGTH: usize = 128;
const MAX_CONTENT_LENGTH: usize = 16_384;
const DEFAULT_MAX_MESSAGES: u32 = 200;
const MAX_ALLOWED_MESSAGES: u32 = 1000;
const DEFAULT_PAGE_SIZE: u32 = 50;

#[derive(Debug, Clone, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
#[borsh(crate = "calimero_sdk::borsh")]
#[serde(crate = "calimero_sdk::serde")]
pub struct ChatMessage {
    pub id: u64,
    pub sender: String,
    pub role: String,
    pub content: String,
    pub timestamp_ms: u64,
}

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    BorshSerialize,
    BorshDeserialize,
    Serialize,
    Deserialize,
)]
#[borsh(crate = "calimero_sdk::borsh")]
#[serde(crate = "calimero_sdk::serde")]
#[serde(rename_all = "snake_case")]
pub enum GameStage {
    NotStarted,
    WaitingForSecret,
    WaitingForQuestion,
    WaitingForAnswer,
    Completed,
}

#[derive(Debug, Clone, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
#[borsh(crate = "calimero_sdk::borsh")]
#[serde(crate = "calimero_sdk::serde")]
pub struct GameInfo {
    pub admin: Option<String>,
    pub player_one: Option<String>,
    pub player_two: Option<String>,
    pub stage: GameStage,
    pub secret_set: bool,
    pub total_messages: u32,
    pub max_messages: u32,
    pub awaiting_player: Option<String>,
}

#[derive(Debug, Clone, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
#[borsh(crate = "calimero_sdk::borsh")]
#[serde(crate = "calimero_sdk::serde")]
pub struct AnswerResult {
    pub message: ChatMessage,
    pub guess_was_correct: bool,
}

#[derive(Debug, Clone, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
#[borsh(crate = "calimero_sdk::borsh")]
#[serde(crate = "calimero_sdk::serde")]
pub struct GuessResult {
    pub guess_was_correct: bool,
}

#[app::state(emits = for<'a> Event<'a>)]
#[derive(Debug, BorshSerialize, BorshDeserialize)]
#[borsh(crate = "calimero_sdk::borsh")]
pub struct GameState {
    messages: Vec<ChatMessage>,
    max_messages: u32,
    next_id: u64,
    admin: Option<String>,
    player_one: Option<String>,
    player_two: Option<String>,
    secret_raw: Option<String>,
    secret_normalized: Option<String>,
    stage: GameStage,
    last_question_id: Option<u64>,
}

#[app::event]
pub enum Event<'a> {
    MessageAdded {
        id: u64,
        sender: &'a str,
        role: &'a str,
        content: &'a str,
        timestamp_ms: u64,
    },
    HistoryCleared,
    GameCreated {
        admin: &'a str,
        player_one: &'a str,
        player_two: &'a str,
    },
    SecretSet,
    SecretGuessed {
        guesser: &'a str,
    },
    StageChanged {
        stage: &'a str,
    },
}

#[derive(Debug, Error, Serialize)]
#[serde(crate = "calimero_sdk::serde")]
#[serde(tag = "kind", content = "data")]
pub enum Error {
    #[error("name must not be empty")]
    EmptyName,
    #[error("name too long: {0} bytes")]
    NameTooLong(usize),
    #[error("message content must not be empty")]
    EmptyContent,
    #[error("message content too long: {0} bytes")]
    ContentTooLong(usize),
    #[error("game already configured with a different admin")]
    AdminMismatch,
    #[error("game setup incomplete: {0}")]
    GameSetupIncomplete(&'static str),
    #[error("game secret must be configured before playing")]
    SecretNotSet,
    #[error("secret must be a single word without spaces")]
    InvalidSecretFormat,
    #[error("unauthorised action: {0}")]
    Unauthorized(&'static str),
    #[error("turn order violation: {0}")]
    InvalidTurn(&'static str),
    #[error("message not found: {0}")]
    MessageNotFound(u64),
    #[error("max messages must be between 1 and {MAX_ALLOWED_MESSAGES}")]
    InvalidMaxMessages,
}

impl GameStage {
    fn as_label(&self) -> &'static str {
        match self {
            GameStage::NotStarted => "not_started",
            GameStage::WaitingForSecret => "waiting_for_secret",
            GameStage::WaitingForQuestion => "waiting_for_question",
            GameStage::WaitingForAnswer => "waiting_for_answer",
            GameStage::Completed => "completed",
        }
    }

    fn awaiting_player(&self, state: &GameState) -> Option<String> {
        match self {
            GameStage::WaitingForSecret => state.admin.clone(),
            GameStage::WaitingForQuestion => state.player_one.clone(),
            GameStage::WaitingForAnswer => state.player_two.clone(),
            GameStage::Completed | GameStage::NotStarted => None,
        }
    }
}

impl GameState {
    fn validate_name(input: &str) -> app::Result<String> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            app::bail!(Error::EmptyName);
        }
        if trimmed.len() > MAX_NAME_LENGTH {
            app::bail!(Error::NameTooLong(trimmed.len()));
        }
        Ok(trimmed.to_owned())
    }

    fn validate_message_content(content: &str) -> app::Result<String> {
        let trimmed = content.trim();
        if trimmed.is_empty() {
            app::bail!(Error::EmptyContent);
        }
        if trimmed.len() > MAX_CONTENT_LENGTH {
            app::bail!(Error::ContentTooLong(trimmed.len()));
        }
        Ok(trimmed.to_owned())
    }

    fn ensure_admin(&self, candidate: &str) -> app::Result<String> {
        let cleaned = Self::validate_name(candidate)?;
        match &self.admin {
            Some(admin) if admin == &cleaned => Ok(cleaned),
            Some(_) => app::bail!(Error::Unauthorized(
                "only the configured admin can perform this action"
            )),
            None => app::bail!(Error::GameSetupIncomplete(
                "create_game must be called before this operation"
            )),
        }
    }

    fn ensure_player_one(&self, candidate: &str) -> app::Result<String> {
        let cleaned = Self::validate_name(candidate)?;
        match &self.player_one {
            Some(player) if player == &cleaned => Ok(cleaned),
            Some(_) => app::bail!(Error::Unauthorized(
                "only the registered player one can perform this action"
            )),
            None => app::bail!(Error::GameSetupIncomplete(
                "player one has not been set yet"
            )),
        }
    }

    fn ensure_player_two(&self, candidate: &str) -> app::Result<String> {
        let cleaned = Self::validate_name(candidate)?;
        match &self.player_two {
            Some(player) if player == &cleaned => Ok(cleaned),
            Some(_) => app::bail!(Error::Unauthorized(
                "only the registered player two can perform this action"
            )),
            None => app::bail!(Error::GameSetupIncomplete(
                "player two has not been set yet"
            )),
        }
    }

    fn ensure_secret(&self) -> app::Result<(&String, &String)> {
        match (&self.secret_raw, &self.secret_normalized) {
            (Some(raw), Some(normalized)) => Ok((raw, normalized)),
            _ => app::bail!(Error::SecretNotSet),
        }
    }

    fn normalise_word(word: &str) -> String {
        word.trim().to_lowercase()
    }

    fn append_message(
        &mut self,
        sender: String,
        role: &str,
        content: String,
    ) -> ChatMessage {
        let timestamp_ms = env::time_now() as u64;
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);

        let message = ChatMessage {
            id,
            sender,
            role: role.to_owned(),
            content,
            timestamp_ms,
        };

        self.messages.push(message.clone());
        self.enforce_capacity();

        message
    }

    fn enforce_capacity(&mut self) {
        let max = self.max_messages as usize;
        if self.messages.len() > max {
            let overflow = self.messages.len() - max;
            self.messages.drain(0..overflow);
        }
    }

    fn info_snapshot(&self) -> GameInfo {
        GameInfo {
            admin: self.admin.clone(),
            player_one: self.player_one.clone(),
            player_two: self.player_two.clone(),
            stage: self.stage,
            secret_set: self.secret_raw.is_some(),
            total_messages: self.messages.len() as u32,
            max_messages: self.max_messages,
            awaiting_player: self.stage.awaiting_player(self),
        }
    }

    fn transition_stage(&mut self, next: GameStage) {
        if self.stage != next {
            self.stage = next;
            app::emit!(Event::StageChanged {
                stage: next.as_label()
            });
        }
    }
}

#[app::logic]
impl GameState {
    #[app::init]
    pub fn init() -> GameState {
        GameState {
            messages: Vec::new(),
            max_messages: DEFAULT_MAX_MESSAGES,
            next_id: 0,
            admin: None,
            player_one: None,
            player_two: None,
            secret_raw: None,
            secret_normalized: None,
            stage: GameStage::NotStarted,
            last_question_id: None,
        }
    }

    pub fn create_game(
        &mut self,
        admin: String,
        player_one: String,
        player_two: String,
    ) -> app::Result<GameInfo> {
        let admin = Self::validate_name(&admin)?;
        let player_one = Self::validate_name(&player_one)?;
        let player_two = Self::validate_name(&player_two)?;

        if let Some(existing_admin) = &self.admin {
            if existing_admin != &admin {
                app::bail!(Error::AdminMismatch);
            }
        }

        self.admin = Some(admin.clone());
        self.player_one = Some(player_one.clone());
        self.player_two = Some(player_two.clone());
        self.secret_raw = None;
        self.secret_normalized = None;
        self.transition_stage(GameStage::WaitingForSecret);
        self.messages.clear();
        self.next_id = 0;
        self.last_question_id = None;

        app::emit!(Event::GameCreated {
            admin: &admin,
            player_one: &player_one,
            player_two: &player_two,
        });

        Ok(self.info_snapshot())
    }

    pub fn set_secret(&mut self, requester: String, secret: String) -> app::Result<GameInfo> {
        let _admin = self.ensure_admin(&requester)?;
        let cleaned_secret = Self::validate_name(&secret)?; // reuse name validation for emptiness/len

        if cleaned_secret.split_whitespace().count() != 1 {
            app::bail!(Error::InvalidSecretFormat);
        }

        self.secret_raw = Some(cleaned_secret.clone());
        self.secret_normalized = Some(Self::normalise_word(&cleaned_secret));
        self.transition_stage(GameStage::WaitingForQuestion);
        self.last_question_id = None;

        app::emit!(Event::SecretSet);
        Ok(self.info_snapshot())
    }

    pub fn submit_question(
        &mut self,
        player: String,
        content: String,
    ) -> app::Result<ChatMessage> {
        self.ensure_secret()?;
        let player_one = self.ensure_player_one(&player)?;

        match self.stage {
            GameStage::WaitingForQuestion | GameStage::WaitingForSecret => {}
            GameStage::WaitingForAnswer => {
                app::bail!(Error::InvalidTurn(
                    "an answer is required before asking another question"
                ));
            }
            GameStage::Completed => {
                app::bail!(Error::InvalidTurn(
                    "the game is completed; restart to continue"
                ));
            }
            GameStage::NotStarted => {
                app::bail!(Error::GameSetupIncomplete(
                    "create_game must be called before starting"
                ));
            }
        }

        let message_content = Self::validate_message_content(&content)?;
        let message = self.append_message(player_one, "player_one", message_content);
        self.transition_stage(GameStage::WaitingForAnswer);
        self.last_question_id = Some(message.id);

        app::emit!(Event::MessageAdded {
            id: message.id,
            sender: &message.sender,
            role: &message.role,
            content: &message.content,
            timestamp_ms: message.timestamp_ms,
        });

        Ok(message)
    }

    pub fn submit_answer(
        &mut self,
        player: String,
        content: String,
        guess: Option<String>,
    ) -> app::Result<AnswerResult> {
        self.ensure_secret()?;
        let player_two = self.ensure_player_two(&player)?;

        if self.stage != GameStage::WaitingForAnswer {
            app::bail!(Error::InvalidTurn(
                "an answer can only be submitted after a question"
            ));
        }

        let message_content = Self::validate_message_content(&content)?;
        let message = self.append_message(player_two.clone(), "player_two", message_content);

        let mut guess_was_correct = false;

        if let (Some(secret_norm), Some(guess_value)) =
            (&self.secret_normalized, guess.as_ref())
        {
            if Self::normalise_word(guess_value) == *secret_norm {
                guess_was_correct = true;
                self.transition_stage(GameStage::Completed);
                self.last_question_id = None;
                app::emit!(Event::SecretGuessed { guesser: &player_two });
            } else {
                self.transition_stage(GameStage::WaitingForQuestion);
                self.last_question_id = None;
            }
        } else {
            self.transition_stage(GameStage::WaitingForQuestion);
            self.last_question_id = None;
        }

        app::emit!(Event::MessageAdded {
            id: message.id,
            sender: &message.sender,
            role: &message.role,
            content: &message.content,
            timestamp_ms: message.timestamp_ms,
        });

        Ok(AnswerResult {
            message,
            guess_was_correct,
        })
    }

    pub fn messages(
        &self,
        offset: Option<u32>,
        limit: Option<u32>,
    ) -> app::Result<Vec<ChatMessage>> {
        let total = self.messages.len() as u32;
        let start = offset.unwrap_or(0).min(total) as usize;
        let capped_limit = limit
            .unwrap_or(DEFAULT_PAGE_SIZE)
            .clamp(1, self.max_messages)
            as usize;

        Ok(self
            .messages
            .iter()
            .skip(start)
            .take(capped_limit)
            .cloned()
            .collect())
    }

    pub fn message_by_id(&self, id: u64) -> app::Result<ChatMessage> {
        self.messages
            .iter()
            .find(|message| message.id == id)
            .cloned()
            .ok_or(Error::MessageNotFound(id))
            .map_err(Into::into)
    }

    pub fn clear_history(&mut self, requester: String) -> app::Result<()> {
        let _admin = self.ensure_admin(&requester)?;
        if self.messages.is_empty() {
            return Ok(());
        }

        self.messages.clear();
        self.last_question_id = None;
        app::emit!(Event::HistoryCleared);
        Ok(())
    }

    pub fn set_max_messages(&mut self, requester: String, max_messages: u32) -> app::Result<()> {
        let _admin = self.ensure_admin(&requester)?;
        if max_messages == 0 || max_messages > MAX_ALLOWED_MESSAGES {
            app::bail!(Error::InvalidMaxMessages);
        }

        self.max_messages = max_messages;
        self.enforce_capacity();
        Ok(())
    }

    pub fn game_info(&self) -> app::Result<GameInfo> {
        Ok(self.info_snapshot())
    }

    pub fn check_guess(&self, guess: String) -> app::Result<GuessResult> {
        let (_, normalized) = self.ensure_secret()?;
        let guess_was_correct = Self::normalise_word(&guess) == *normalized;
        Ok(GuessResult { guess_was_correct })
    }

    pub fn get_secret(&self, requester: String) -> app::Result<Option<String>> {
        let cleaned = Self::validate_name(&requester)?;
        if self
            .admin
            .as_ref()
            .filter(|admin| *admin == &cleaned)
            .is_some()
            || self
                .player_two
                .as_ref()
                .filter(|player| *player == &cleaned)
                .is_some()
        {
            return Ok(self.secret_raw.clone());
        }
        Ok(None)
    }

    pub fn debug_reveal_secret(&self) -> app::Result<Option<String>> {
        Ok(self.secret_raw.clone())
    }
}
