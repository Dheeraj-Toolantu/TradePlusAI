export type AuthenticatedUser = { id: string; role: "TRADER" | "STRATEGY_BUILDER" | "ALGO_USER" | "RISK_MANAGER" | "ADMIN" };

export function requireRole(user: AuthenticatedUser | undefined, roles: AuthenticatedUser["role"][]): AuthenticatedUser {
  if (!user || !roles.includes(user.role)) throw new Error("Forbidden");
  return user;
}