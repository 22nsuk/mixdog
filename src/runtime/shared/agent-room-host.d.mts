export interface AgentRoomMessageSource {
  sender?: { agentId: string; name: string };
  hop?: number;
}
export interface AgentRoomHost {
  hasRoom(sessionId: string): Promise<boolean>;
  isRunning(sessionId: string): boolean;
  send(sessionId: string, prompt: unknown, source: AgentRoomMessageSource): Promise<boolean>;
  stop(sessionId: string): boolean;
}
export function registerAgentRoomHost(host: AgentRoomHost): () => void;
export function sendAgentRoomMessage(
  sessionId: string,
  prompt: unknown,
  source?: AgentRoomMessageSource
): Promise<boolean>;
export function stopAgentRoom(sessionId: string): Promise<boolean>;
