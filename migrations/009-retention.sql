-- Identifier-free daily cost totals. Detailed receipts have a separate TTL.
CREATE TABLE quota_daily_totals (
  day date PRIMARY KEY,
  reservations bigint NOT NULL CHECK (reservations > 0),
  charged_cost_micros numeric(30,0) NOT NULL CHECK (charged_cost_micros >= 0),
  unknown_usage bigint NOT NULL CHECK (unknown_usage BETWEEN 0 AND reservations)
);
