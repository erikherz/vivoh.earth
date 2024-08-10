#!/bin/bash

while true; do
  # Count the number of active "moq-sub" processes
  count=$(ps aux | grep -v grep | grep moq-sub | wc -l)
  
  # Get the CPU load (1-minute average)
  cpu_load=$(awk '{print $1}' /proc/loadavg)
  
  # Print the count and CPU load
  echo "Active moq-sub processes: $count | CPU Load: $cpu_load"
  
  # Sleep for 1 seconds
  sleep 1
done
