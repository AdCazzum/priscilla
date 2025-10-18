#!/usr/bin/env node

/**
 * Event-Driven Agent Simulator
 * Simulates the EventClient polling and processing events
 */

import fs from 'fs';
import path from 'path';

const eventsPath = './iexec_in/events.json';
const responsesPath = './iexec_out/responses.json';
const pollInterval = parseInt(process.env.EVENT_POLL_INTERVAL || '5000');

console.log('\n🤖 Event-Driven Agent Starting...\n');
console.log(`📂 Events path: ${eventsPath}`);
console.log(`📂 Responses path: ${responsesPath}`);
console.log(`⏱️  Poll interval: ${pollInterval}ms (${pollInterval/1000}s)`);
console.log('\n' + '='.repeat(60) + '\n');

// Initialize responses file
if (!fs.existsSync('./iexec_out')) {
  fs.mkdirSync('./iexec_out', { recursive: true });
}
if (!fs.existsSync(responsesPath)) {
  fs.writeFileSync(responsesPath, JSON.stringify([], null, 2));
}

// Track processed events
const processedEvents = new Set();

// Load character for context
let character;
try {
  character = JSON.parse(fs.readFileSync('./iexec_in/character', 'utf8'));
  console.log(`✅ Character loaded: ${character.name}`);
  console.log(`📝 System prompt: ${character.system.substring(0, 100)}...`);
} catch (error) {
  console.log('⚠️  Could not load character, using defaults');
  character = { name: 'iexec-intern' };
}

console.log('\n' + '='.repeat(60) + '\n');

// Function to generate AI response (mock)
function generateResponse(event, character) {
  const { query } = event;
  
  // Create a more contextual mock response based on character
  const responses = [
    `Based on my knowledge as ${character.name}, I can help you with that. ${query} - This relates to confidential computing and decentralized infrastructure.`,
    `Great question! As an expert in iExec technology, let me explain: iExec provides confidential computing through TEEs (Trusted Execution Environments), allowing secure off-chain computation.`,
    `The iExec platform enables developers to build privacy-preserving applications. Your question about "${query}" touches on core concepts of our decentralized cloud infrastructure.`,
    `Regarding "${query}" - This is handled through our DataProtector SDK and confidential computing framework, ensuring data privacy and monetization capabilities.`,
    `Excellent inquiry! In the context of iExec's infrastructure: TEEs provide hardware-based security, enabling confidential AI and secure data processing.`
  ];
  
  // Pick a response based on event ID (deterministic but varied)
  const hash = event.id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const selectedResponse = responses[hash % responses.length];
  
  return selectedResponse;
}

// Polling function
function pollEvents() {
  try {
    // Check if events file exists
    if (!fs.existsSync(eventsPath)) {
      console.log('⏳ Waiting for events file...');
      return;
    }

    // Read events
    const eventsData = fs.readFileSync(eventsPath, 'utf8');
    const events = JSON.parse(eventsData);

    // Filter new events
    const newEvents = events.filter(event => !processedEvents.has(event.id));

    if (newEvents.length > 0) {
      console.log(`\n🔔 Found ${newEvents.length} new event(s) to process\n`);

      // Process each new event
      newEvents.forEach((event, index) => {
        console.log(`📨 Event ${index + 1}/${newEvents.length}`);
        console.log(`   ID: ${event.id}`);
        console.log(`   Query: ${event.query}`);
        if (event.metadata) {
          console.log(`   Metadata: ${JSON.stringify(event.metadata)}`);
        }

        // Generate response
        const responseText = generateResponse(event, character);
        
        const response = {
          queryId: event.id,
          response: responseText,
          timestamp: Date.now(),
          agentId: character.name || 'iexec-intern'
        };

        // Load existing responses
        const responses = JSON.parse(fs.readFileSync(responsesPath, 'utf8'));
        responses.push(response);
        fs.writeFileSync(responsesPath, JSON.stringify(responses, null, 2));

        processedEvents.add(event.id);
        
        console.log(`   ✅ Response generated and saved`);
        console.log(`   📝 Preview: ${responseText.substring(0, 80)}...`);
        console.log('');
      });

      console.log('='.repeat(60) + '\n');
    }
  } catch (error) {
    console.error('❌ Error polling events:', error.message);
  }
}

// Start polling
console.log('🚀 Agent started! Polling for events...\n');
pollEvents(); // Initial poll

const intervalId = setInterval(pollEvents, pollInterval);

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n🛑 Shutting down agent...');
  clearInterval(intervalId);
  console.log('✅ Agent stopped gracefully\n');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\n🛑 Shutting down agent...');
  clearInterval(intervalId);
  console.log('✅ Agent stopped gracefully\n');
  process.exit(0);
});

// Keep alive message
setInterval(() => {
  const responses = JSON.parse(fs.readFileSync(responsesPath, 'utf8'));
  console.log(`💚 Agent alive | Processed: ${processedEvents.size} | Responses: ${responses.length} | Next poll in ${pollInterval/1000}s`);
}, pollInterval * 2);
