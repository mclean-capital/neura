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

# Always install/update dependencies to ensure environment is correct
echo "Installing/updating dependencies (forcing reinstall)..."
pip install --upgrade -r requirements.txt
echo "Dependencies installed/updated."

# Run the agent
echo "Starting agent service..."
if [ "$1" == "dev" ]; then
    echo "Running in development mode..."
    python -m src.main dev
else
    echo "Running in production mode..."
    python -m src.main start
fi
