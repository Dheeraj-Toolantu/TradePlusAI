export class KillSwitchService {
  private active = false;
  activate(reason: string) { this.active = true; return { active: true, reason, occurredAt: new Date().toISOString() }; }
  deactivate() { this.active = false; return { active: false, occurredAt: new Date().toISOString() }; }
  isActive() { return this.active; }
}