# Architecture rules

- Keep temporary quiet-hours exemptions in a shared, expiry-aware helper used by guest controls and automatic spa shutoff so enforcement cannot diverge and restrictions resume without another deployment.