#!/bin/bash

# Check if the peak number and block size are provided as command-line arguments
if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage: $0 <peak_number> <instances_per_second>"
    exit 1
fi

# Set the peak number and block size from the command-line arguments
PEAK_NUMBER=$1
INSTANCES_PER_SECOND=$2

# Command template
CMD="RUST_LOG=moq_sub=info /home/ubuntu/moq-rs/target/release/moq-sub --name \"test\" \"https://test-server.vivoh.earth/watch\" > /dev/null 2>&1"

# Function to start a new instance
start_instance() {
    eval "$CMD &"
}

# Function to stop all instances
stop_all_instances() {
    pkill -f "moq-sub"
}

# Ramp up
echo "Ramping up..."
CURRENT_INSTANCES=0
while [ $CURRENT_INSTANCES -lt $PEAK_NUMBER ]; do
    for (( i=1; i<=INSTANCES_PER_SECOND && CURRENT_INSTANCES<$PEAK_NUMBER; i++ ))
    do
        start_instance
        CURRENT_INSTANCES=$((CURRENT_INSTANCES + 1))
        echo "Started $CURRENT_INSTANCES instance(s)"
    done
    sleep 1
done

# Hold all instances for 1 minute
echo "Holding all $PEAK_NUMBER instances for 1 minute..."
sleep 60

# Ramp down
echo "Ramping down..."
while [ $CURRENT_INSTANCES -gt 0 ]; do
    stop_all_instances
    CURRENT_INSTANCES=$((CURRENT_INSTANCES - INSTANCES_PER_SECOND))
    echo "Stopped $CURRENT_INSTANCES instance(s)"
    sleep 1
done

echo "Script complete."
