bump: patch

### Fixed
- Disabling an authoritative rule now stops only its known owned workers, including when it was the provider's last enabled rule. Configuration reconciliation uses fresh complete inventory and generation leases; disconnects, invalid updates, missing rules and ambiguous ownership preserve workers. OFF/ON races recheck authority before every destructive RPC.
