#!/bin/bash

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
for (( i=1; i<=1000; i++ ))
do
    start_instance
    echo "Started $i instance(s)"
    sleep 1
done

# Hold all instances for 1 minute
echo "Holding all 1000 instances for 1 minute..."
sleep 60

# Ramp down
echo "Ramping down..."
for (( i=1000; i>0; i-- ))
do
    stop_all_instances
    echo "Stopped $i instance(s)"
    sleep 1
done

echo "Script complete."
