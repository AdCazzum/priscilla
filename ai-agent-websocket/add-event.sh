#!/bin/bash

# Add Event Helper Script
# Quickly add new events to the events.json file

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

EVENTS_FILE="iexec_in/events.json"

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo -e "${YELLOW}⚠️  jq is not installed. Installing jq is recommended for JSON manipulation.${NC}"
    echo "You can install it with: brew install jq (macOS) or apt-get install jq (Linux)"
    exit 1
fi

# Check if events file exists
if [ ! -f "$EVENTS_FILE" ]; then
    echo "[]" > "$EVENTS_FILE"
    echo -e "${GREEN}✅ Created new events file${NC}"
fi

# Get query from argument or prompt
if [ -z "$1" ]; then
    echo -e "${BLUE}Enter your query:${NC}"
    read -r QUERY
else
    QUERY="$*"
fi

if [ -z "$QUERY" ]; then
    echo "Error: Query cannot be empty"
    exit 1
fi

# Generate event ID and timestamp
EVENT_ID="evt-$(date +%s%N)"
TIMESTAMP=$(date +%s000)

# Optional metadata
echo -e "${BLUE}Add metadata? (y/n, default: n)${NC}"
read -r ADD_METADATA

METADATA="{}"
if [ "$ADD_METADATA" = "y" ] || [ "$ADD_METADATA" = "Y" ]; then
    echo "User ID (optional):"
    read -r USER_ID
    
    echo "Priority (low/medium/high, optional):"
    read -r PRIORITY
    
    echo "Category (optional):"
    read -r CATEGORY
    
    # Build metadata JSON
    METADATA=$(jq -n \
        --arg uid "${USER_ID:-anonymous}" \
        --arg prio "${PRIORITY:-medium}" \
        --arg cat "${CATEGORY:-general}" \
        '{userId: $uid, priority: $prio, category: $cat, source: "cli"}')
fi

# Add event to file
jq --arg id "$EVENT_ID" \
   --arg query "$QUERY" \
   --argjson ts "$TIMESTAMP" \
   --argjson meta "$METADATA" \
   '. += [{id: $id, query: $query, timestamp: $ts, metadata: $meta}]' \
   "$EVENTS_FILE" > "${EVENTS_FILE}.tmp" && mv "${EVENTS_FILE}.tmp" "$EVENTS_FILE"

echo ""
echo -e "${GREEN}✅ Event added successfully!${NC}"
echo -e "${BLUE}Event ID: $EVENT_ID${NC}"
echo -e "${BLUE}Query: $QUERY${NC}"
echo ""
echo "Total events in queue: $(jq 'length' "$EVENTS_FILE")"
