import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";

type StorageLike = {
	getItem: (key: string) => string | null;
	setItem: (key: string, value: string) => void;
	removeItem: (key: string) => void;
	clear: () => void;
};

function createStorageMock(): StorageLike {
	const store = new Map<string, string>();

	return {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => {
			store.set(key, String(value));
		},
		removeItem: (key: string) => {
			store.delete(key);
		},
		clear: () => {
			store.clear();
		},
	};
}

Object.defineProperty(window, "localStorage", {
	configurable: true,
	value: createStorageMock(),
});

await import("@/i18n/config");

beforeEach(() => {
	window.localStorage.clear();
});
