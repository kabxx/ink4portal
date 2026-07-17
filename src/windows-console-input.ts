import {createRequire} from 'node:module';
import {Buffer} from 'node:buffer';
import {type InputKeyEvent} from './input-event.js';
import {type ParsedKey} from './parse-keypress.js';

const inputRecordSize = 20;
const keyEventType = 0x1;
const windowBufferSizeEventType = 0x4;
const standardInputHandle = -10;
const waitObject0 = 0;
const waitTimeout = 0x1_02;
const waitFailed = 0xff_ff_ff_ff;
const defaultWaitTimeoutMilliseconds = 50;
const defaultMaximumRecordsPerRead = 128;
const enableProcessedInput = 0x1;
const enableLineInput = 0x2;
const enableEchoInput = 0x4;
const enableVirtualTerminalInput = 0x2_00;
const windowsRawInputFlags =
	enableProcessedInput +
	enableLineInput +
	enableEchoInput +
	enableVirtualTerminalInput;

const virtualKey = {
	backspace: 0x08,
	tab: 0x09,
	return: 0x0d,
	shift: 0x10,
	control: 0x11,
	alt: 0x12,
	pause: 0x13,
	capsLock: 0x14,
	escape: 0x1b,
	space: 0x20,
	pageUp: 0x21,
	pageDown: 0x22,
	end: 0x23,
	home: 0x24,
	left: 0x25,
	up: 0x26,
	right: 0x27,
	down: 0x28,
	printScreen: 0x2c,
	insert: 0x2d,
	delete: 0x2e,
	leftWindows: 0x5b,
	rightWindows: 0x5c,
	numLock: 0x90,
	scrollLock: 0x91,
	leftShift: 0xa0,
	rightShift: 0xa1,
	leftControl: 0xa2,
	rightControl: 0xa3,
	leftAlt: 0xa4,
	rightAlt: 0xa5,
} as const;

export const windowsConsoleControlKeyState = {
	rightAlt: 0x1,
	leftAlt: 0x2,
	rightControl: 0x4,
	leftControl: 0x8,
	shift: 0x10,
	numLock: 0x20,
	capsLock: 0x80,
	enhancedKey: 0x1_00,
} as const;

export const windowsConsoleInputRecordSize = inputRecordSize;

export const getWindowsRawInputMode = (mode: number): number =>
	// eslint-disable-next-line no-bitwise
	mode & ~windowsRawInputFlags;

export type WindowsConsoleInputMode = 'auto' | 'enabled' | 'disabled';

export type WindowsConsoleInputOptions = {
	/**
	 * Select the native Win32 console input backend. `auto` uses it only with
	 * the process stdin TTY on Windows and falls back to Node stdin if native
	 * initialization fails.
	 */
	mode?: WindowsConsoleInputMode;
};

export type WindowsConsoleResizeEvent = {
	readonly type: 'resize';
	readonly columns: number;
	readonly rows: number;
};

export type WindowsConsoleInputEvent =
	string | InputKeyEvent | WindowsConsoleResizeEvent;

type WindowsKeyRecord = {
	readonly keyDown: boolean;
	readonly repeatCount: number;
	readonly virtualKeyCode: number;
	readonly virtualScanCode: number;
	readonly unicodeCodeUnit: number;
	readonly controlKeyState: number;
};

type KeyDescription = {
	readonly name: string;
	readonly sequence: string;
	readonly text?: string;
	readonly isPrintable: boolean;
};

const specialKeys: Readonly<Record<number, KeyDescription>> = {
	[virtualKey.backspace]: {
		name: 'backspace',
		sequence: '\u007F',
		isPrintable: false,
	},
	[virtualKey.escape]: {
		name: 'escape',
		sequence: '\u001B',
		isPrintable: false,
	},
	[virtualKey.pageUp]: {
		name: 'pageup',
		sequence: '\u001B[5~',
		isPrintable: false,
	},
	[virtualKey.pageDown]: {
		name: 'pagedown',
		sequence: '\u001B[6~',
		isPrintable: false,
	},
	[virtualKey.end]: {
		name: 'end',
		sequence: '\u001B[F',
		isPrintable: false,
	},
	[virtualKey.home]: {
		name: 'home',
		sequence: '\u001B[H',
		isPrintable: false,
	},
	[virtualKey.left]: {
		name: 'left',
		sequence: '\u001B[D',
		isPrintable: false,
	},
	[virtualKey.up]: {
		name: 'up',
		sequence: '\u001B[A',
		isPrintable: false,
	},
	[virtualKey.right]: {
		name: 'right',
		sequence: '\u001B[C',
		isPrintable: false,
	},
	[virtualKey.down]: {
		name: 'down',
		sequence: '\u001B[B',
		isPrintable: false,
	},
	[virtualKey.insert]: {
		name: 'insert',
		sequence: '\u001B[2~',
		isPrintable: false,
	},
	[virtualKey.delete]: {
		name: 'delete',
		sequence: '\u001B[3~',
		isPrintable: false,
	},
	[virtualKey.pause]: {
		name: 'pause',
		sequence: '',
		isPrintable: false,
	},
	[virtualKey.printScreen]: {
		name: 'printscreen',
		sequence: '',
		isPrintable: false,
	},
};

const modifierOnlyKeys = new Set<number>([
	virtualKey.shift,
	virtualKey.control,
	virtualKey.alt,
	virtualKey.capsLock,
	virtualKey.leftWindows,
	virtualKey.rightWindows,
	virtualKey.numLock,
	virtualKey.scrollLock,
	virtualKey.leftShift,
	virtualKey.rightShift,
	virtualKey.leftControl,
	virtualKey.rightControl,
	virtualKey.leftAlt,
	virtualKey.rightAlt,
]);

const hasFlag = (value: number, flag: number): boolean => {
	// eslint-disable-next-line no-bitwise
	return (value & flag) !== 0;
};

const modifiedEnterCodePoints = new Set([0x0a, 0x0d]);

export const enrichModifiedEnterRecords = (
	buffer: Uint8Array,
	recordCount: number,
	controlKeyState: number,
): void => {
	if (controlKeyState === 0) {
		return;
	}

	const view = new DataView(
		buffer.buffer,
		buffer.byteOffset,
		buffer.byteLength,
	);
	for (let index = 0; index < recordCount; index++) {
		const offset = index * inputRecordSize;
		if (
			view.getUint16(offset, true) !== keyEventType ||
			view.getInt32(offset + 4, true) === 0 ||
			![0, virtualKey.return].includes(view.getUint16(offset + 10, true)) ||
			!modifiedEnterCodePoints.has(view.getUint16(offset + 14, true))
		) {
			continue;
		}

		view.setUint16(offset + 10, virtualKey.return, true);
		view.setUint16(offset + 12, 0x1c, true);
		view.setUint16(offset + 14, 0x0d, true);
		const recordControlKeyState = view.getUint32(offset + 16, true);
		// eslint-disable-next-line no-bitwise
		const mergedControlKeyState = recordControlKeyState | controlKeyState;
		view.setUint32(offset + 16, mergedControlKeyState, true);
	}
};

const getModifiers = (controlKeyState: number) => ({
	ctrl:
		hasFlag(controlKeyState, windowsConsoleControlKeyState.leftControl) ||
		hasFlag(controlKeyState, windowsConsoleControlKeyState.rightControl),
	meta:
		hasFlag(controlKeyState, windowsConsoleControlKeyState.leftAlt) ||
		hasFlag(controlKeyState, windowsConsoleControlKeyState.rightAlt),
	shift: hasFlag(controlKeyState, windowsConsoleControlKeyState.shift),
	altGr:
		hasFlag(controlKeyState, windowsConsoleControlKeyState.leftControl) &&
		hasFlag(controlKeyState, windowsConsoleControlKeyState.rightAlt) &&
		!hasFlag(controlKeyState, windowsConsoleControlKeyState.rightControl) &&
		!hasFlag(controlKeyState, windowsConsoleControlKeyState.leftAlt),
	capsLock: hasFlag(controlKeyState, windowsConsoleControlKeyState.capsLock),
	numLock: hasFlag(controlKeyState, windowsConsoleControlKeyState.numLock),
});

const describeTextKey = (
	record: WindowsKeyRecord,
	text: string,
): KeyDescription => {
	switch (text) {
		case '\r': {
			return {name: 'return', sequence: text, text, isPrintable: true};
		}

		case '\n': {
			return {name: 'enter', sequence: text, text, isPrintable: true};
		}

		case '\t': {
			return {name: 'tab', sequence: text, isPrintable: false};
		}

		case '\b':
		case '\u007F': {
			return {name: 'backspace', sequence: text, isPrintable: false};
		}

		case '\u001B': {
			return {name: 'escape', sequence: text, isPrintable: false};
		}

		case ' ': {
			return {name: 'space', sequence: text, text, isPrintable: true};
		}

		default: {
			const codePoint = text.codePointAt(0) ?? 0;
			const {ctrl} = getModifiers(record.controlKeyState);
			if (ctrl && codePoint >= 1 && codePoint <= 26) {
				return {
					name: String.fromCodePoint(codePoint + 96),
					sequence: text,
					isPrintable: false,
				};
			}

			return {
				name: text.toLowerCase(),
				sequence: text,
				text,
				isPrintable: true,
			};
		}
	}
};

const describeVirtualKey = (
	record: WindowsKeyRecord,
): KeyDescription | undefined => {
	if (record.virtualKeyCode === virtualKey.return) {
		return {name: 'return', sequence: '\r', text: '\r', isPrintable: true};
	}

	if (record.virtualKeyCode === virtualKey.tab) {
		return {
			name: 'tab',
			sequence: getModifiers(record.controlKeyState).shift ? '\u001B[Z' : '\t',
			isPrintable: false,
		};
	}

	if (record.virtualKeyCode === virtualKey.space) {
		return {name: 'space', sequence: ' ', text: ' ', isPrintable: true};
	}

	if (record.virtualKeyCode >= 0x70 && record.virtualKeyCode <= 0x87) {
		return {
			name: `f${record.virtualKeyCode - 0x6f}`,
			sequence: '',
			isPrintable: false,
		};
	}

	return specialKeys[record.virtualKeyCode];
};

const createKeypress = (
	record: WindowsKeyRecord,
	description: KeyDescription,
	eventType: 'press' | 'repeat',
): ParsedKey => {
	const modifiers = getModifiers(record.controlKeyState);
	const isAltGrText = description.isPrintable && modifiers.altGr;

	return {
		...modifiers,
		ctrl: isAltGrText ? false : modifiers.ctrl,
		meta: isAltGrText ? false : modifiers.meta,
		name: description.name,
		sequence: description.sequence,
		raw: description.sequence || undefined,
		super: false,
		hyper: false,
		eventType,
		isStructuredInput: true,
		isPrintable: description.isPrintable,
		text: description.text,
	};
};

const appendRawText = (
	events: WindowsConsoleInputEvent[],
	text: string,
): void => {
	const previous = events.at(-1);
	if (typeof previous === 'string') {
		events[events.length - 1] = previous + text;
		return;
	}

	events.push(text);
};

const appendKeyEvents = (
	events: WindowsConsoleInputEvent[],
	record: WindowsKeyRecord,
	description: KeyDescription,
): void => {
	const repeatCount = Math.max(1, record.repeatCount);
	for (let index = 0; index < repeatCount; index++) {
		events.push({
			type: 'key',
			keypress: createKeypress(
				record,
				description,
				index === 0 ? 'press' : 'repeat',
			),
		});
	}
};

const appendDecodedKey = (
	events: WindowsConsoleInputEvent[],
	record: WindowsKeyRecord,
	text: string | undefined,
): void => {
	// Alt+numpad input is finalized on the VK_MENU key-up record. Windows puts
	// the resulting Unicode character on that release event, so preserve it as
	// text instead of treating the record as a modifier-only key.
	if (
		!record.keyDown &&
		record.virtualKeyCode === virtualKey.alt &&
		text !== undefined
	) {
		appendRawText(events, text.repeat(Math.max(1, record.repeatCount)));
		return;
	}

	if (modifierOnlyKeys.has(record.virtualKeyCode)) {
		return;
	}

	// Windows Terminal and IMEs use zero virtual-key/scan codes for injected
	// Unicode. Keep these records as text chunks so bracketed paste markers and
	// composition output continue through Ink's existing stream parser.
	if (
		text !== undefined &&
		(record.virtualKeyCode === 0 || record.virtualScanCode === 0)
	) {
		appendRawText(events, text.repeat(Math.max(1, record.repeatCount)));
		return;
	}

	const description =
		text === undefined
			? describeVirtualKey(record)
			: describeTextKey(record, text);
	if (!description) {
		return;
	}

	appendKeyEvents(events, record, description);
};

const readKeyRecord = (view: DataView, offset: number): WindowsKeyRecord => ({
	keyDown: view.getInt32(offset + 4, true) !== 0,
	repeatCount: view.getUint16(offset + 8, true),
	virtualKeyCode: view.getUint16(offset + 10, true),
	virtualScanCode: view.getUint16(offset + 12, true),
	unicodeCodeUnit: view.getUint16(offset + 14, true),
	controlKeyState: view.getUint32(offset + 16, true),
});

const isHighSurrogate = (codeUnit: number): boolean =>
	codeUnit >= 0xd8_00 && codeUnit <= 0xdb_ff;

const isLowSurrogate = (codeUnit: number): boolean =>
	codeUnit >= 0xdc_00 && codeUnit <= 0xdf_ff;

export type WindowsInputRecordDecoder = {
	decode: (
		buffer: Uint8Array,
		recordCount: number,
	) => WindowsConsoleInputEvent[];
	reset: () => void;
};

export const createWindowsInputRecordDecoder =
	(): WindowsInputRecordDecoder => {
		let pendingHighSurrogate: WindowsKeyRecord | undefined;

		return {
			decode(buffer, recordCount) {
				if (recordCount < 0 || buffer.length < recordCount * inputRecordSize) {
					throw new RangeError('Invalid Win32 INPUT_RECORD buffer length');
				}

				const events: WindowsConsoleInputEvent[] = [];
				const view = new DataView(
					buffer.buffer,
					buffer.byteOffset,
					buffer.byteLength,
				);
				for (let index = 0; index < recordCount; index++) {
					const offset = index * inputRecordSize;
					const eventType = view.getUint16(offset, true);
					if (eventType === windowBufferSizeEventType) {
						events.push({
							type: 'resize',
							columns: view.getInt16(offset + 4, true),
							rows: view.getInt16(offset + 6, true),
						});
						continue;
					}

					if (eventType !== keyEventType) {
						continue;
					}

					// Win32 defines dwControlKeyState for this specific record. Treat it as
					// authoritative: console hosts can inject text before the modifier key-up
					// that follows the paste operation.
					const record = readKeyRecord(view, offset);

					const isAltCodeRelease =
						!record.keyDown &&
						record.virtualKeyCode === virtualKey.alt &&
						record.unicodeCodeUnit !== 0;
					if (!record.keyDown && !isAltCodeRelease) {
						continue;
					}

					if (pendingHighSurrogate) {
						if (isLowSurrogate(record.unicodeCodeUnit)) {
							const codePoint =
								(pendingHighSurrogate.unicodeCodeUnit - 0xd8_00) * 0x4_00 +
								(record.unicodeCodeUnit - 0xdc_00) +
								0x1_00_00;
							const text = String.fromCodePoint(codePoint);
							appendDecodedKey(events, record, text);
							pendingHighSurrogate = undefined;
							continue;
						}

						appendDecodedKey(events, pendingHighSurrogate, '\uFFFD');
						pendingHighSurrogate = undefined;
					}

					if (isHighSurrogate(record.unicodeCodeUnit)) {
						pendingHighSurrogate = record;
						continue;
					}

					const text =
						record.unicodeCodeUnit === 0
							? undefined
							: isLowSurrogate(record.unicodeCodeUnit)
								? '\uFFFD'
								: String.fromCodePoint(record.unicodeCodeUnit);
					appendDecodedKey(events, record, text);
				}

				return events;
			},
			reset() {
				pendingHighSurrogate = undefined;
			},
		};
	};

type WaitResult = 'ready' | 'timeout';

export type WindowsConsoleApi = {
	openInput: () => {readonly handle: unknown; readonly mode: number};
	setInputMode: (handle: unknown, mode: number) => void;
	restoreInputMode: (handle: unknown, mode: number) => void;
	waitForInput: (
		handle: unknown,
		timeoutMilliseconds: number,
		callback: (error: unknown, result?: WaitResult) => void,
	) => void;
	getPendingEventCount: (handle: unknown) => number;
	readInput: (
		handle: unknown,
		maximumRecordCount: number,
	) => {readonly buffer: Uint8Array; readonly recordCount: number};
};

type ForeignFunction = ((...arguments_: unknown[]) => unknown) & {
	async?: (...arguments_: unknown[]) => void;
};

type KoffiLibrary = {
	func: (definition: string) => ForeignFunction;
};

type KoffiModule = {
	load: (path: string) => KoffiLibrary;
};

const isKoffiModule = (value: unknown): value is KoffiModule => {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	return typeof (value as {load?: unknown}).load === 'function';
};

const getNumericResult = (value: unknown, operation: string): number => {
	if (typeof value === 'number') {
		return value;
	}

	if (typeof value === 'bigint') {
		return Number(value);
	}

	throw new TypeError(`${operation} returned a non-numeric result`);
};

let cachedWindowsConsoleApi: WindowsConsoleApi | undefined;

const loadWindowsConsoleApi = (): WindowsConsoleApi => {
	if (cachedWindowsConsoleApi) {
		return cachedWindowsConsoleApi;
	}

	const require = createRequire(import.meta.url);
	const koffiValue: unknown = require('koffi');
	if (!isKoffiModule(koffiValue)) {
		throw new TypeError(
			'The optional koffi package did not expose its FFI API',
		);
	}

	const kernel32 = koffiValue.load('kernel32.dll');
	const user32 = koffiValue.load('user32.dll');
	const getStdHandle = kernel32.func(
		'void * __stdcall GetStdHandle(int32_t nStdHandle)',
	);
	const getConsoleMode = kernel32.func(
		'int32_t __stdcall GetConsoleMode(void *hConsoleHandle, _Out_ uint32_t *lpMode)',
	);
	const setConsoleMode = kernel32.func(
		'int32_t __stdcall SetConsoleMode(void *hConsoleHandle, uint32_t dwMode)',
	);
	const waitForSingleObject = kernel32.func(
		'uint32_t __stdcall WaitForSingleObject(void *hHandle, uint32_t dwMilliseconds)',
	);
	const getNumberOfConsoleInputEvents = kernel32.func(
		'int32_t __stdcall GetNumberOfConsoleInputEvents(void *hConsoleInput, _Out_ uint32_t *lpcNumberOfEvents)',
	);
	const readConsoleInput = kernel32.func(
		'int32_t __stdcall ReadConsoleInputW(void *hConsoleInput, void *lpBuffer, uint32_t nLength, _Out_ uint32_t *lpNumberOfEventsRead)',
	);
	const getLastError = kernel32.func('uint32_t __stdcall GetLastError()');
	const getAsyncKeyState = user32.func(
		'int16_t __stdcall GetAsyncKeyState(int32_t vKey)',
	);

	const readModifierState = (): number => {
		const isPressed = (virtualKeyCode: number): boolean =>
			hasFlag(
				getNumericResult(getAsyncKeyState(virtualKeyCode), 'GetAsyncKeyState'),
				32_768,
			);
		let state = 0;
		if (isPressed(virtualKey.shift)) {
			state += windowsConsoleControlKeyState.shift;
		}

		if (isPressed(virtualKey.leftControl)) {
			state += windowsConsoleControlKeyState.leftControl;
		}

		if (isPressed(virtualKey.rightControl)) {
			state += windowsConsoleControlKeyState.rightControl;
		}

		if (
			!hasFlag(
				state,
				windowsConsoleControlKeyState.leftControl +
					windowsConsoleControlKeyState.rightControl,
			) &&
			isPressed(virtualKey.control)
		) {
			state += windowsConsoleControlKeyState.leftControl;
		}

		if (isPressed(virtualKey.leftAlt)) {
			state += windowsConsoleControlKeyState.leftAlt;
		}

		if (isPressed(virtualKey.rightAlt)) {
			state += windowsConsoleControlKeyState.rightAlt;
		}

		if (
			!hasFlag(
				state,
				windowsConsoleControlKeyState.leftAlt +
					windowsConsoleControlKeyState.rightAlt,
			) &&
			isPressed(virtualKey.alt)
		) {
			state += windowsConsoleControlKeyState.leftAlt;
		}

		return state;
	};

	const createNativeError = (operation: string): Error => {
		const errorCode = getNumericResult(getLastError(), 'GetLastError');
		return new Error(`${operation} failed with Win32 error ${errorCode}`);
	};

	const api: WindowsConsoleApi = {
		openInput() {
			const handle = getStdHandle(standardInputHandle);
			const mode = [0];
			if (!getConsoleMode(handle, mode)) {
				throw createNativeError('GetConsoleMode');
			}

			return {handle, mode: mode[0] ?? 0};
		},
		setInputMode(handle, mode) {
			if (!setConsoleMode(handle, mode)) {
				throw createNativeError('SetConsoleMode');
			}
		},
		restoreInputMode(handle, mode) {
			if (!setConsoleMode(handle, mode)) {
				throw createNativeError('SetConsoleMode');
			}
		},
		waitForInput(handle, timeoutMilliseconds, callback) {
			if (typeof waitForSingleObject.async !== 'function') {
				callback(new Error('Koffi does not support asynchronous Win32 calls'));
				return;
			}

			waitForSingleObject.async(
				handle,
				timeoutMilliseconds,
				(error: unknown, value: unknown) => {
					if (error) {
						callback(error);
						return;
					}

					try {
						const result = getNumericResult(value, 'WaitForSingleObject');
						if (result === waitObject0) {
							callback(undefined, 'ready');
							return;
						}

						if (result === waitTimeout) {
							callback(undefined, 'timeout');
							return;
						}

						callback(
							result === waitFailed
								? new Error('WaitForSingleObject failed')
								: new Error(`WaitForSingleObject returned ${result}`),
						);
					} catch (nativeError) {
						callback(nativeError);
					}
				},
			);
		},
		getPendingEventCount(handle) {
			const count = [0];
			if (!getNumberOfConsoleInputEvents(handle, count)) {
				throw createNativeError('GetNumberOfConsoleInputEvents');
			}

			return count[0] ?? 0;
		},
		readInput(handle, maximumRecordCount) {
			const buffer = Buffer.allocUnsafe(maximumRecordCount * inputRecordSize);
			const count = [0];
			if (!readConsoleInput(handle, buffer, maximumRecordCount, count)) {
				throw createNativeError('ReadConsoleInputW');
			}

			const recordCount = count[0] ?? 0;
			// Windows Terminal versions without Win32 input mode collapse modified
			// Enter into a Unicode record. Keep this narrow fallback for those hosts;
			// all other keys use the INPUT_RECORD state directly.
			enrichModifiedEnterRecords(buffer, recordCount, readModifierState());
			return {buffer, recordCount};
		},
	};

	cachedWindowsConsoleApi = api;
	return api;
};

export type WindowsConsoleInputBackend = {
	start: () => void;
	stop: () => void;
	isActive: () => boolean;
};

type CreateWindowsConsoleInputArguments = {
	readonly onEvent: (event: WindowsConsoleInputEvent) => void;
	readonly onError: (error: unknown) => void;
	readonly apiFactory?: () => WindowsConsoleApi;
	readonly waitTimeoutMilliseconds?: number;
	readonly maximumRecordsPerRead?: number;
};

export const createWindowsConsoleInput = ({
	onEvent,
	onError,
	apiFactory = loadWindowsConsoleApi,
	waitTimeoutMilliseconds = defaultWaitTimeoutMilliseconds,
	maximumRecordsPerRead = defaultMaximumRecordsPerRead,
}: CreateWindowsConsoleInputArguments): WindowsConsoleInputBackend => {
	const decoder = createWindowsInputRecordDecoder();
	let active = false;
	let generation = 0;
	let api: WindowsConsoleApi | undefined;
	let handle: unknown;
	let originalMode: number | undefined;

	const restoreInputMode = (): void => {
		if (!api || handle === undefined || originalMode === undefined) {
			return;
		}

		api.restoreInputMode(handle, originalMode);
		originalMode = undefined;
	};

	const fail = (error: unknown, expectedGeneration: number): void => {
		if (!active || generation !== expectedGeneration) {
			return;
		}

		active = false;
		generation++;
		decoder.reset();
		try {
			restoreInputMode();
		} catch {}

		onError(error);
	};

	const wait = (expectedGeneration: number): void => {
		if (!active || generation !== expectedGeneration || !api) {
			return;
		}

		try {
			api.waitForInput(handle, waitTimeoutMilliseconds, (error, result) => {
				if (!active || generation !== expectedGeneration) {
					return;
				}

				if (error) {
					fail(error, expectedGeneration);
					return;
				}

				let events: WindowsConsoleInputEvent[] = [];
				if (result === 'ready') {
					try {
						const pendingEventCount = api!.getPendingEventCount(handle);
						if (pendingEventCount > 0) {
							const input = api!.readInput(
								handle,
								Math.min(pendingEventCount, maximumRecordsPerRead),
							);
							events = decoder.decode(input.buffer, input.recordCount);
						}
					} catch (nativeError) {
						fail(nativeError, expectedGeneration);
						return;
					}
				}

				for (const event of events) {
					onEvent(event);
				}

				queueMicrotask(() => {
					wait(expectedGeneration);
				});
			});
		} catch (error) {
			fail(error, expectedGeneration);
		}
	};

	return {
		start() {
			if (active) {
				return;
			}

			const nextApi = apiFactory();
			const input = nextApi.openInput();
			api = nextApi;
			handle = input.handle;
			originalMode = input.mode;
			try {
				nextApi.setInputMode(handle, getWindowsRawInputMode(input.mode));
				active = true;
				generation++;
				decoder.reset();
				wait(generation);
			} catch (error) {
				active = false;
				generation++;
				decoder.reset();
				try {
					restoreInputMode();
				} catch {}

				throw error;
			}
		},
		stop() {
			if (!active) {
				return;
			}

			active = false;
			generation++;
			decoder.reset();
			restoreInputMode();
			api = undefined;
			handle = undefined;
			originalMode = undefined;
		},
		isActive() {
			return active;
		},
	};
};

export const shouldUseWindowsConsoleInput = ({
	mode = 'auto',
	platform,
	isTty,
	isDefaultStdin,
	hasStdinListeners = false,
}: {
	readonly mode?: WindowsConsoleInputMode;
	readonly platform: NodeJS.Platform;
	readonly isTty: boolean;
	readonly isDefaultStdin: boolean;
	readonly hasStdinListeners?: boolean;
}): boolean => {
	return (
		mode !== 'disabled' &&
		platform === 'win32' &&
		isTty &&
		isDefaultStdin &&
		!hasStdinListeners
	);
};
