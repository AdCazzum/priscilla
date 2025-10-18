use calimero_sdk::app;
use calimero_sdk::borsh::{BorshDeserialize, BorshSerialize};
use calimero_sdk::env;
use calimero_sdk::serde::{Deserialize, Serialize};
use thiserror::Error;

const DEFAULT_MAX_MESSAGES: u32 = 200;
const MAX_ALLOWED_MESSAGES: u32 = 1000;
const DEFAULT_PAGE_SIZE: u32 = 50;
const MAX_CONTENT_LENGTH: usize = 16_384;
const MAX_SENDER_LENGTH: usize = 128;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(crate = "calimero_sdk::serde")]
pub struct ChatInfo {
    pub total_messages: u32,
    pub max_messages: u32,
}

#[app::state(emits = for<'a> Event<'a>)]
#[derive(Debug, BorshSerialize, BorshDeserialize)]
#[borsh(crate = "calimero_sdk::borsh")]
pub struct ChatState {
    messages: Vec<ChatMessage>,
    max_messages: u32,
    next_id: u64,
}

#[app::event]
pub enum Event<'a> {
    MessageAdded { id: u64, sender: &'a str, role: &'a str },
    HistoryCleared,
    MaxMessagesUpdated { max_messages: u32 },
}

#[derive(Debug, Error, Serialize)]
#[serde(crate = "calimero_sdk::serde")]
#[serde(tag = "kind", content = "data")]
pub enum Error {
    #[error("sender must not be empty")]
    EmptySender,
    #[error("message content must not be empty")]
    EmptyContent,
    #[error("sender too long: {0} bytes")]
    SenderTooLong(usize),
    #[error("content too long: {0} bytes")]
    ContentTooLong(usize),
    #[error("max messages must be between 1 and {MAX_ALLOWED_MESSAGES}")]
    InvalidMaxMessages,
}

#[app::logic]
impl ChatState {
    #[app::init]
    pub fn init() -> ChatState {
        ChatState {
            messages: Vec::new(),
            max_messages: DEFAULT_MAX_MESSAGES,
            next_id: 0,
        }
    }

    pub fn send_message(
        &mut self,
        sender: String,
        role: String,
        content: String,
    ) -> app::Result<ChatMessage> {
        let trimmed_sender = sender.trim();
        if trimmed_sender.is_empty() {
            app::bail!(Error::EmptySender);
        }

        if trimmed_sender.len() > MAX_SENDER_LENGTH {
            app::bail!(Error::SenderTooLong(trimmed_sender.len()));
        }

        let trimmed_content = content.trim();
        if trimmed_content.is_empty() {
            app::bail!(Error::EmptyContent);
        }

        if trimmed_content.len() > MAX_CONTENT_LENGTH {
            app::bail!(Error::ContentTooLong(trimmed_content.len()));
        }

        let timestamp_ms = env::time_now() as u64;
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);

        let message = ChatMessage {
            id,
            sender: trimmed_sender.to_owned(),
            role: role.trim().to_owned(),
            content: trimmed_content.to_owned(),
            timestamp_ms,
        };

        self.push_message(message.clone());

        app::emit!(Event::MessageAdded {
            id,
            sender: &message.sender,
            role: &message.role,
        });

        Ok(message)
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

    pub fn message_by_id(&self, id: u64) -> app::Result<Option<ChatMessage>> {
        Ok(self
            .messages
            .iter()
            .find(|message| message.id == id)
            .cloned())
    }

    pub fn clear_history(&mut self) -> app::Result<()> {
        if self.messages.is_empty() {
            return Ok(());
        }

        self.messages.clear();
        app::emit!(Event::HistoryCleared);
        Ok(())
    }

    pub fn set_max_messages(&mut self, max_messages: u32) -> app::Result<()> {
        if max_messages == 0 || max_messages > MAX_ALLOWED_MESSAGES {
            app::bail!(Error::InvalidMaxMessages);
        }

        self.max_messages = max_messages;
        self.enforce_capacity();
        app::emit!(Event::MaxMessagesUpdated { max_messages });
        Ok(())
    }

    pub fn info(&self) -> app::Result<ChatInfo> {
        Ok(ChatInfo {
            total_messages: self.messages.len() as u32,
            max_messages: self.max_messages,
        })
    }

    fn push_message(&mut self, message: ChatMessage) {
        self.messages.push(message);
        self.enforce_capacity();
    }

    fn enforce_capacity(&mut self) {
        let max = self.max_messages as usize;
        if self.messages.len() > max {
            let overflow = self.messages.len() - max;
            self.messages.drain(0..overflow);
        }
    }
}
