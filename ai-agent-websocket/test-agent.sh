#!/bin/bash

# Event-Driven Agent Test Script
# This script helps you test the agent locally

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
MODEL_NAME="${1:-qwen2.5:0.5b}"
MODEL_ID="${2:-a8b0c5157701}"
IMAGE_NAME="eliza:latest"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Event-Driven Agent Test Suite${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Function to print colored messages
print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Check if Docker is running
print_info "Checking Docker..."
if ! docker info > /dev/null 2>&1; then
    print_error "Docker is not running. Please start Docker and try again."
    exit 1
fi
print_success "Docker is running"

# Check if directories exist
print_info "Checking directories..."
mkdir -p iexec_in iexec_out
print_success "Directories ready"

# Check if character file exists
if [ ! -f "iexec_in/character" ]; then
    print_error "Character file not found at iexec_in/character"
    exit 1
fi
print_success "Character file found"

# Create example events if not exists
if [ ! -f "iexec_in/events.json" ]; then
    print_warning "events.json not found, creating example file..."
    if [ -f "iexec_in/events.json.example" ]; then
        cp iexec_in/events.json.example iexec_in/events.json
        print_success "Created events.json from example"
    else
        print_info "Creating default events.json..."
        cat > iexec_in/events.json << 'EOF'
[
  {
    "id": "test-001",
    "query": "What is iExec?",
    "timestamp": 1700000000000,
    "metadata": {
      "source": "test-script"
    }
  }
]
EOF
        print_success "Created default events.json"
    fi
fi

# Count events
EVENT_COUNT=$(cat iexec_in/events.json | jq 'length')
print_info "Found $EVENT_COUNT events to process"

# Build Docker image
print_info "Building Docker image..."
if docker build -t "$IMAGE_NAME" . > /tmp/docker-build.log 2>&1; then
    print_success "Docker image built successfully"
else
    print_error "Docker build failed. Check /tmp/docker-build.log for details"
    exit 1
fi

# Clean output directory
print_info "Cleaning output directory..."
rm -f iexec_out/*.json iexec_out/*.txt
print_success "Output directory cleaned"

# Run the container
print_info "Starting agent container..."
echo -e "${YELLOW}Model: $MODEL_NAME${NC}"
echo -e "${YELLOW}Model ID: $MODEL_ID${NC}"
echo ""

docker run --rm --name eliza-test \
  -v "$(pwd)/iexec_in:/iexec_in" \
  -v "$(pwd)/iexec_out:/iexec_out" \
  -e IEXEC_DATASET_FILENAME=character \
  -e IEXEC_IN=/iexec_in \
  -e IEXEC_OUT=/iexec_out \
  -e EVENT_POLL_INTERVAL=3000 \
  "$IMAGE_NAME" "$MODEL_NAME $MODEL_ID"

# Check results
echo ""
print_info "Checking results..."

if [ -f "iexec_out/responses.json" ]; then
    RESPONSE_COUNT=$(cat iexec_out/responses.json | jq 'length')
    print_success "Generated $RESPONSE_COUNT responses"
    
    echo ""
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}  Responses Preview${NC}"
    echo -e "${BLUE}========================================${NC}"
    cat iexec_out/responses.json | jq '.'
else
    print_warning "No responses file generated"
fi

if [ -f "iexec_out/stderr.txt" ] && [ -s "iexec_out/stderr.txt" ]; then
    print_warning "Errors detected, check iexec_out/stderr.txt"
    echo ""
    echo -e "${YELLOW}Error log:${NC}"
    cat iexec_out/stderr.txt
fi

echo ""
print_success "Test completed!"
echo -e "${BLUE}========================================${NC}"
