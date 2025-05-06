#!/bin/bash
# Script to run the agent service

# Set up virtual environment if it doesn't exist
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python -m venv venv
fi

# Activate virtual environment
echo "Activating virtual environment..."
source venv/bin/activate

# Install dependencies if needed
if [ "$1" == "--install" ] || [ "$1" == "-i" ]; then
    echo "Installing dependencies..."
    pip install -r requirements.txt
    shift # Remove the install argument
fi

# Run the agent
echo "Starting agent service..."
if [ "$1" == "dev" ]; then
    echo "Running in development mode..."
    python -m src.main dev
else
    echo "Running in production mode..."
    python -m src.main start
fi
