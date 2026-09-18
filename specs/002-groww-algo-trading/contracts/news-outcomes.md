# News Outcome Contract

Each event records:

```text
event -> AI prediction -> market reaction -> 1m -> 5m -> 15m -> 30m -> 1h -> 1d -> accuracy
```

Outcome evaluation appends realized movement and accuracy. It cannot mutate the original event,
prediction, confidence, or impact score. Calibration reports are separate artifacts consumed by
future model/rule versions.