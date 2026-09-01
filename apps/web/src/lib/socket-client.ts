import PartySocket from "partysocket";

const PARTY_PREFIX = "ws/parties";
const MAX_RETRIES = 12;
const MAX_DELIVERED_EVENT_IDS = 1_000;

export interface RealtimeEvent {
	type: string;
	payload: Record<string, unknown>;
}

type RealtimeEventMap = {
	connect: () => void;
	event: (event: RealtimeEvent) => void;
	notification: (event: RealtimeEvent) => void;
};

type RealtimeEventName = keyof RealtimeEventMap;
type AnyListener = (...args: never[]) => void;

export interface RealtimeSocket {
	readonly connected: boolean;
	connect(): RealtimeSocket;
	disconnect(): RealtimeSocket;
	on<T extends RealtimeEventName>(
		event: T,
		listener: RealtimeEventMap[T],
	): RealtimeSocket;
	off<T extends RealtimeEventName>(
		event: T,
		listener: RealtimeEventMap[T],
	): RealtimeSocket;
}

type PartyMessage = RealtimeEvent & {
	id?: string;
	kind: "event" | "notification";
};

function parsePartyMessage(data: unknown): PartyMessage | null {
	if (typeof data !== "string") return null;
	try {
		const value = JSON.parse(data) as Record<string, unknown>;
		if (
			(value.kind !== "event" && value.kind !== "notification") ||
			typeof value.type !== "string" ||
			!value.payload ||
			typeof value.payload !== "object" ||
			Array.isArray(value.payload)
		) {
			return null;
		}
		return {
			...(typeof value.id === "string" && value.id ? { id: value.id } : {}),
			kind: value.kind,
			type: value.type,
			payload: value.payload as Record<string, unknown>,
		};
	} catch {
		return null;
	}
}

class PacaRealtimeSocket implements RealtimeSocket {
	private userId: string | null = null;
	private userSocket: PartySocket | null = null;
	private readonly projectSockets = new Map<string, PartySocket>();
	private readonly listeners = new Map<RealtimeEventName, Set<AnyListener>>();
	private readonly deliveredEventIds = new Set<string>();

	get connected(): boolean {
		return this.sockets().some(
			(partySocket) => partySocket.readyState === WebSocket.OPEN,
		);
	}

	connect(): RealtimeSocket {
		for (const partySocket of this.sockets()) partySocket.reconnect();
		return this;
	}

	disconnect(): RealtimeSocket {
		for (const partySocket of this.sockets())
			partySocket.close(1000, "client disconnect");
		this.userSocket = null;
		this.projectSockets.clear();
		this.userId = null;
		this.deliveredEventIds.clear();
		return this;
	}

	on<T extends RealtimeEventName>(
		event: T,
		listener: RealtimeEventMap[T],
	): RealtimeSocket {
		const listeners = this.listeners.get(event) ?? new Set<AnyListener>();
		listeners.add(listener as AnyListener);
		this.listeners.set(event, listeners);
		return this;
	}

	off<T extends RealtimeEventName>(
		event: T,
		listener: RealtimeEventMap[T],
	): RealtimeSocket {
		this.listeners.get(event)?.delete(listener as AnyListener);
		return this;
	}

	connectUser(userId: string): void {
		if (this.userId === userId && this.userSocket) return;
		this.userSocket?.close(1000, "user changed");
		this.userId = userId;
		this.userSocket = this.createPartySocket("user-party", userId);
	}

	joinProject(projectId: string): void {
		if (this.projectSockets.has(projectId)) return;
		this.projectSockets.set(
			projectId,
			this.createPartySocket("project-party", projectId),
		);
	}

	leaveProject(projectId: string): void {
		this.projectSockets.get(projectId)?.close(1000, "project unsubscribed");
		this.projectSockets.delete(projectId);
	}

	reconnectProject(projectId: string): void {
		this.projectSockets.get(projectId)?.reconnect();
	}

	private createPartySocket(
		party: "project-party" | "user-party",
		room: string,
	): PartySocket {
		const partySocket = new PartySocket({
			host: window.location.host,
			party,
			room,
			prefix: PARTY_PREFIX,
			maxRetries: MAX_RETRIES,
			maxEnqueuedMessages: 16,
		});
		partySocket.addEventListener("open", () => this.emit("connect"));
		partySocket.addEventListener("message", (message) => {
			const event = parsePartyMessage(message.data);
			if (event && this.acceptEventId(event.id))
				this.emit(event.kind, { type: event.type, payload: event.payload });
		});
		return partySocket;
	}

	private acceptEventId(id: string | undefined): boolean {
		if (!id) return true;
		if (this.deliveredEventIds.has(id)) return false;
		this.deliveredEventIds.add(id);
		if (this.deliveredEventIds.size > MAX_DELIVERED_EVENT_IDS) {
			const oldest = this.deliveredEventIds.values().next().value;
			if (oldest) this.deliveredEventIds.delete(oldest);
		}
		return true;
	}

	private emit<T extends RealtimeEventName>(
		event: T,
		value?: Parameters<RealtimeEventMap[T]>[0],
	): void {
		for (const listener of this.listeners.get(event) ?? []) {
			(listener as (argument?: typeof value) => void)(value);
		}
	}

	private sockets(): PartySocket[] {
		return [this.userSocket, ...this.projectSockets.values()].filter(
			(partySocket): partySocket is PartySocket => Boolean(partySocket),
		);
	}
}

let socket: PacaRealtimeSocket | null = null;
const projectSubscriberCounts = new Map<string, number>();

export function connectSocket(userId?: string): RealtimeSocket {
	socket ??= new PacaRealtimeSocket();
	if (userId) socket.connectUser(userId);
	return socket;
}

export function disconnectSocket(): void {
	socket?.disconnect();
	socket = null;
	projectSubscriberCounts.clear();
}

export function getSocket(): RealtimeSocket | null {
	return socket;
}

export function joinProject(projectId: string): void {
	const count = projectSubscriberCounts.get(projectId) ?? 0;
	projectSubscriberCounts.set(projectId, count + 1);
	if (count === 0) socket?.joinProject(projectId);
}

export function leaveProject(projectId: string): void {
	const count = projectSubscriberCounts.get(projectId) ?? 0;
	if (count <= 1) {
		projectSubscriberCounts.delete(projectId);
		socket?.leaveProject(projectId);
		return;
	}
	projectSubscriberCounts.set(projectId, count - 1);
}

export function rejoinProject(projectId: string): void {
	socket?.reconnectProject(projectId);
}
