export type ExecutionCommand = { internalReference: string; status: "CREATED" | "SUBMITTED" | "UNKNOWN" | "RECONCILIATION_REQUIRED"; brokerOrderId?: string };

export class ExecutionRepository {
  private readonly commands = new Map<string, ExecutionCommand>();
  save(command: ExecutionCommand) { this.commands.set(command.internalReference, command); return command; }
  get(reference: string) { return this.commands.get(reference); }
}