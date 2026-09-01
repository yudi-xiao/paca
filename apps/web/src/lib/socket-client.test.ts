import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockPartySocket = {
	options: Record<string, unknown>;
	readyState: number;
	reconnect: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	addEventListener: ReturnType<typeof vi.fn>;
	listeners: Map<string, (event: unknown) => void>;
};

const { mockPartySocketConstructor, partySockets } = vi.hoisted(() => {
	const sockets: MockPartySocket[] = [];
	const partySocketFactory = vi.fn(
		class implements MockPartySocket {
			readonly options: Record<string, unknown>;
			readyState = 0;
			readonly reconnect = vi.fn();
			readonly close = vi.fn();
			readonly listeners = new Map<string, (event: unknown) => void>();
			readonly addEventListener = vi.fn(
				(event: string, listener: (value: unknown) => void) => {
					this.listeners.set(event, listener);
				},
			);

			constructor(options: Record<string, unknown>) {
				this.options = options;
				sockets.push(this);
			}
		},
	);
	return {
		mockPartySocketConstructor: partySocketFactory,
		partySockets: sockets,
	};
});

vi.mock("partysocket", () => ({ default: mockPartySocketConstructor }));

import {
	connectSocket,
	disconnectSocket,
	getSocket,
	joinProject,
	leaveProject,
	rejoinProject,
} from "./socket-client";

describe("PartySocket realtime client", () => {
	beforeEach(() => {
		disconnectSocket();
		partySockets.length = 0;
		vi.clearAllMocks();
	});

	afterEach(() => disconnectSocket());

	it("opens a same-origin UserParty for the authenticated user", () => {
		connectSocket("user-1");

		expect(mockPartySocketConstructor).toHaveBeenCalledWith(
			expect.objectContaining({
				host: window.location.host,
				party: "user-party",
				room: "user-1",
				prefix: "ws/parties",
			}),
		);
		expect(connectSocket("user-1")).toBe(getSocket());
		expect(mockPartySocketConstructor).toHaveBeenCalledTimes(1);
	});

	it("opens one ProjectParty per subscribed project and reference-counts subscribers", () => {
		connectSocket();
		joinProject("project-1");
		joinProject("project-1");

		expect(mockPartySocketConstructor).toHaveBeenCalledTimes(1);
		expect(partySockets[0]?.options).toMatchObject({
			party: "project-party",
			room: "project-1",
		});

		leaveProject("project-1");
		expect(partySockets[0]?.close).not.toHaveBeenCalled();
		leaveProject("project-1");
		expect(partySockets[0]?.close).toHaveBeenCalledWith(
			1000,
			"project unsubscribed",
		);
	});

	it("routes validated Party messages to event and notification listeners", () => {
		const client = connectSocket("user-1");
		const onEvent = vi.fn();
		const onNotification = vi.fn();
		client.on("event", onEvent).on("notification", onNotification);
		const message = partySockets[0]?.listeners.get("message");

		message?.({
			data: JSON.stringify({
				kind: "event",
				type: "agent.updated",
				payload: { id: "1" },
			}),
		});
		message?.({
			data: JSON.stringify({
				kind: "notification",
				type: "notification.created",
				payload: { id: "2" },
			}),
		});
		message?.({ data: JSON.stringify({ kind: "event", payload: [] }) });

		expect(onEvent).toHaveBeenCalledWith({
			type: "agent.updated",
			payload: { id: "1" },
		});
		expect(onNotification).toHaveBeenCalledWith({
			type: "notification.created",
			payload: { id: "2" },
		});
		expect(onEvent).toHaveBeenCalledTimes(1);
	});

	it("ignores a reliable event delivered more than once", () => {
		const client = connectSocket("user-1");
		const onEvent = vi.fn();
		client.on("event", onEvent);
		const message = partySockets[0]?.listeners.get("message");
		const data = JSON.stringify({
			id: "11111111-1111-4111-8111-111111111111",
			kind: "event",
			type: "task.updated",
			payload: { project_id: "project-1", task_id: "task-1" },
		});

		message?.({ data });
		message?.({ data });

		expect(onEvent).toHaveBeenCalledTimes(1);
	});

	it("reconnects active parties without changing project subscriber counts", () => {
		connectSocket("user-1");
		joinProject("project-1");
		rejoinProject("project-1");
		connectSocket().connect();

		expect(partySockets[1]?.reconnect).toHaveBeenCalledTimes(2);
		expect(partySockets[0]?.reconnect).toHaveBeenCalledTimes(1);
		leaveProject("project-1");
		expect(partySockets[1]?.close).toHaveBeenCalledTimes(1);
	});

	it("closes every PartySocket and clears the singleton on logout", () => {
		connectSocket("user-1");
		joinProject("project-1");
		disconnectSocket();

		expect(partySockets[0]?.close).toHaveBeenCalledWith(
			1000,
			"client disconnect",
		);
		expect(partySockets[1]?.close).toHaveBeenCalledWith(
			1000,
			"client disconnect",
		);
		expect(getSocket()).toBeNull();
	});
});
