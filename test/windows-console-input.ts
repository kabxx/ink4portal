import {Buffer} from 'node:buffer';
import test from 'ava';
import {createElement} from 'react';
import {getInputFromKeypress} from '../src/input-event.js';
import {createInputParser} from '../src/input-parser.js';
import {render, useInput, type Key} from '../src/index.js';
import {useStdinContext} from '../src/hooks/use-stdin.js';
import {
	createWindowsConsoleInput,
	createWindowsInputRecordDecoder,
	enrichModifiedEnterRecords,
	getWindowsRawInputMode,
	shouldUseWindowsConsoleInput,
	windowsConsoleControlKeyState,
	windowsConsoleInputRecordSize,
	type WindowsConsoleApi,
	type WindowsConsoleInputEvent,
} from '../src/windows-console-input.js';
import {createStdin} from './helpers/create-stdin.js';
import createStdout from './helpers/create-stdout.js';

type TestInputRecord = {
	readonly eventType?: number;
	readonly keyDown?: boolean;
	readonly repeatCount?: number;
	readonly virtualKeyCode?: number;
	readonly virtualScanCode?: number;
	readonly unicodeCodeUnit?: number;
	readonly controlKeyState?: number;
	readonly columns?: number;
	readonly rows?: number;
};

const keyEvent = 0x1;

const createInputRecords = (records: readonly TestInputRecord[]) => {
	const buffer = Buffer.alloc(records.length * windowsConsoleInputRecordSize);

	for (const [index, record] of records.entries()) {
		const offset = index * windowsConsoleInputRecordSize;
		const eventType = record.eventType ?? keyEvent;
		buffer.writeUInt16LE(eventType, offset);
		if (eventType === 0x4) {
			buffer.writeInt16LE(record.columns ?? 80, offset + 4);
			buffer.writeInt16LE(record.rows ?? 24, offset + 6);
			continue;
		}

		buffer.writeInt32LE(record.keyDown === false ? 0 : 1, offset + 4);
		buffer.writeUInt16LE(record.repeatCount ?? 1, offset + 8);
		buffer.writeUInt16LE(record.virtualKeyCode ?? 0, offset + 10);
		buffer.writeUInt16LE(record.virtualScanCode ?? 0, offset + 12);
		buffer.writeUInt16LE(record.unicodeCodeUnit ?? 0, offset + 14);
		buffer.writeUInt32LE(record.controlKeyState ?? 0, offset + 16);
	}

	return buffer;
};

const decode = (records: readonly TestInputRecord[]) => {
	const decoder = createWindowsInputRecordDecoder();
	return decoder.decode(createInputRecords(records), records.length);
};

const getKeyEvents = (events: readonly WindowsConsoleInputEvent[]) =>
	events.filter(event => typeof event !== 'string' && event.type === 'key');

test('enriches a legacy ConPTY Enter record with the active physical modifier state', t => {
	const buffer = createInputRecords([{unicodeCodeUnit: 0x0a}]);
	enrichModifiedEnterRecords(
		buffer,
		1,
		windowsConsoleControlKeyState.shift +
			windowsConsoleControlKeyState.leftControl,
	);

	const events = getKeyEvents(
		createWindowsInputRecordDecoder().decode(buffer, 1),
	);
	t.is(events.length, 1);
	t.is(events[0]!.keypress.name, 'return');
	t.true(events[0]!.keypress.shift);
	t.true(events[0]!.keypress.ctrl);
	t.is(events[0]!.keypress.sequence, '\r');
});

test('uses a Windows raw mode that preserves console records and restores it', t => {
	t.is(getWindowsRawInputMode(0x1_f7), 0x1_f0);
	t.is(getWindowsRawInputMode(0x2_08), 0x8);
});

test('leaves unmodified legacy ConPTY text records on the raw-text path', t => {
	const buffer = createInputRecords([{unicodeCodeUnit: 0x0a}]);
	enrichModifiedEnterRecords(buffer, 1, 0);
	t.deepEqual(createWindowsInputRecordDecoder().decode(buffer, 1), ['\n']);
});

test('distinguishes Enter from Shift+Enter without changing input text', t => {
	const events = getKeyEvents(
		decode([
			{
				virtualKeyCode: 0x0d,
				virtualScanCode: 0x1c,
				unicodeCodeUnit: 0x0d,
			},
			{
				virtualKeyCode: 0x0d,
				virtualScanCode: 0x1c,
				unicodeCodeUnit: 0x0d,
				controlKeyState: windowsConsoleControlKeyState.shift,
			},
		]),
	);

	t.is(events.length, 2);
	t.is(events[0]!.keypress.name, 'return');
	t.false(events[0]!.keypress.shift);
	t.is(getInputFromKeypress(events[0]!.keypress), '\r');
	t.is(events[1]!.keypress.name, 'return');
	t.true(events[1]!.keypress.shift);
	t.is(getInputFromKeypress(events[1]!.keypress), '\r');
});

test('tracks Shift when the Enter record omits its modifier state', t => {
	const events = getKeyEvents(
		decode([
			{
				virtualKeyCode: 0x10,
				virtualScanCode: 0x2a,
				controlKeyState: windowsConsoleControlKeyState.shift,
			},
			{
				virtualKeyCode: 0x0d,
				virtualScanCode: 0x1c,
				unicodeCodeUnit: 0x0d,
			},
			{
				keyDown: false,
				virtualKeyCode: 0x10,
				virtualScanCode: 0x2a,
			},
			{
				virtualKeyCode: 0x0d,
				virtualScanCode: 0x1c,
				unicodeCodeUnit: 0x0d,
			},
		]),
	);

	t.is(events.length, 2);
	t.true(events[0]!.keypress.shift);
	t.false(events[1]!.keypress.shift);
});

test('delivers a structured Shift+Enter event through useInput', t => {
	let emitter: ReturnType<typeof useStdinContext>['internal_eventEmitter'];
	let received: {input: string; key: Key} | undefined;

	// eslint-disable-next-line @typescript-eslint/naming-convention
	function InputReceiver() {
		emitter = useStdinContext().internal_eventEmitter;
		useInput((input, key) => {
			received = {input, key};
		});
		return null;
	}

	const stdin = createStdin() as unknown as NodeJS.ReadStream;
	const stdout = createStdout();
	const instance = render(createElement(InputReceiver), {
		stdin,
		stdout,
		windowsConsoleInput: {mode: 'disabled'},
	});
	const [event] = getKeyEvents(
		decode([
			{
				virtualKeyCode: 0x0d,
				virtualScanCode: 0x1c,
				unicodeCodeUnit: 0x0d,
				controlKeyState: windowsConsoleControlKeyState.shift,
			},
		]),
	);

	emitter!.emit('input', event!);

	t.is(received?.input, '\r');
	t.true(received?.key.return);
	t.true(received?.key.shift);

	const [capsLockEvent] = getKeyEvents(
		decode([
			{
				virtualKeyCode: 0x41,
				virtualScanCode: 0x1e,
				unicodeCodeUnit: 0x41,
				controlKeyState: windowsConsoleControlKeyState.capsLock,
			},
		]),
	);
	emitter!.emit('input', capsLockEvent!);
	t.is(received?.input, 'A');
	t.false(received?.key.shift);
	t.true(received?.key.capsLock);

	const [altGrEvent] = getKeyEvents(
		decode([
			{
				virtualKeyCode: 0x51,
				virtualScanCode: 0x10,
				unicodeCodeUnit: 0x40,
				controlKeyState:
					windowsConsoleControlKeyState.leftControl +
					windowsConsoleControlKeyState.rightAlt,
			},
		]),
	);
	emitter!.emit('input', altGrEvent!);
	t.is(received?.input, '@');
	t.true(received?.key.altGr);
	t.false(received?.key.ctrl);
	t.false(received?.key.meta);
	instance.unmount();
});

test('preserves Ctrl, Alt, Shift, Caps Lock, and Num Lock state', t => {
	const controlState =
		windowsConsoleControlKeyState.leftControl +
		windowsConsoleControlKeyState.leftAlt +
		windowsConsoleControlKeyState.shift +
		windowsConsoleControlKeyState.capsLock +
		windowsConsoleControlKeyState.numLock;
	const [event] = getKeyEvents(
		decode([
			{
				virtualKeyCode: 0x58,
				virtualScanCode: 0x2d,
				unicodeCodeUnit: 'X'.codePointAt(0) ?? 0,
				controlKeyState: controlState,
			},
		]),
	);

	t.truthy(event);
	t.true(event!.keypress.ctrl);
	t.true(event!.keypress.meta);
	t.true(event!.keypress.shift);
	t.true(event!.keypress.capsLock);
	t.true(event!.keypress.numLock);
	t.is(getInputFromKeypress(event!.keypress), 'X');
});

test('normalizes printable AltGr input without shortcut modifiers', t => {
	const [event] = getKeyEvents(
		decode([
			{
				virtualKeyCode: 0x51,
				virtualScanCode: 0x10,
				unicodeCodeUnit: 0x40,
				controlKeyState:
					windowsConsoleControlKeyState.leftControl +
					windowsConsoleControlKeyState.rightAlt,
			},
		]),
	);

	t.true(event!.keypress.altGr);
	t.false(event!.keypress.ctrl);
	t.false(event!.keypress.meta);
	t.is(getInputFromKeypress(event!.keypress), '@');
});

test('normalizes Ctrl+letter shortcuts to their letter input', t => {
	const [event] = getKeyEvents(
		decode([
			{
				virtualKeyCode: 0x43,
				virtualScanCode: 0x2e,
				unicodeCodeUnit: 0x03,
				controlKeyState: windowsConsoleControlKeyState.leftControl,
			},
		]),
	);

	t.is(event!.keypress.name, 'c');
	t.true(event!.keypress.ctrl);
	t.false(event!.keypress.isPrintable);
	t.is(getInputFromKeypress(event!.keypress), 'c');
});

test('decodes modified arrows and function keys as non-printable keys', t => {
	const events = getKeyEvents(
		decode([
			{
				virtualKeyCode: 0x26,
				virtualScanCode: 0x48,
				controlKeyState: windowsConsoleControlKeyState.shift,
			},
			{virtualKeyCode: 0x74, virtualScanCode: 0x3f},
		]),
	);

	t.is(events[0]!.keypress.name, 'up');
	t.true(events[0]!.keypress.shift);
	t.is(getInputFromKeypress(events[0]!.keypress), '');
	t.is(events[1]!.keypress.name, 'f5');
	t.is(getInputFromKeypress(events[1]!.keypress), '');
});

test('expands repeat counts and labels repeated key events', t => {
	const events = getKeyEvents(
		decode([
			{
				repeatCount: 3,
				virtualKeyCode: 0x41,
				virtualScanCode: 0x1e,
				unicodeCodeUnit: 0x61,
			},
		]),
	);

	t.deepEqual(
		events.map(event => event.keypress.eventType),
		['press', 'repeat', 'repeat'],
	);
	t.deepEqual(
		events.map(event => getInputFromKeypress(event.keypress)),
		['a', 'a', 'a'],
	);
});

test('ignores key-up, modifier-only, and unsupported input records', t => {
	t.deepEqual(
		decode([
			{
				keyDown: false,
				virtualKeyCode: 0x41,
				virtualScanCode: 0x1e,
				unicodeCodeUnit: 0x61,
			},
			{virtualKeyCode: 0x10, virtualScanCode: 0x2a},
			{eventType: 0x2},
		]),
		[],
	);
});

test('preserves Alt+numpad Unicode from the Alt key-up record', t => {
	t.deepEqual(
		decode([
			{
				keyDown: false,
				virtualKeyCode: 0x12,
				unicodeCodeUnit: 0xe9,
			},
		]),
		['é'],
	);
});

test('preserves window resize records for Ink resize handling', t => {
	t.deepEqual(decode([{eventType: 0x4, columns: 120, rows: 40}]), [
		{type: 'resize', columns: 120, rows: 40},
	]);
});

test('assembles UTF-16 surrogate pairs across native reads', t => {
	const decoder = createWindowsInputRecordDecoder();
	const high = createInputRecords([{unicodeCodeUnit: 0xd8_3d}]);
	const low = createInputRecords([{unicodeCodeUnit: 0xde_00}]);

	t.deepEqual(decoder.decode(high, 1), []);
	t.deepEqual(decoder.decode(low, 1), ['😀']);
});

test('coalesces injected Unicode so bracketed paste stays on the paste path', t => {
	const value = '\u001B[200~line 1\nline 2\u001B[201~';
	const records = [...value].map(character => ({
		unicodeCodeUnit: character.codePointAt(0) ?? 0,
	}));
	const events = decode(records);

	t.deepEqual(events, [value]);
	const parser = createInputParser();
	t.deepEqual(parser.push(events[0] as string), [{paste: 'line 1\nline 2'}]);
});

test('rejects a truncated INPUT_RECORD buffer', t => {
	const decoder = createWindowsInputRecordDecoder();
	const error = t.throws(() => {
		decoder.decode(Buffer.alloc(windowsConsoleInputRecordSize - 1), 1);
	});

	t.is(error.message, 'Invalid Win32 INPUT_RECORD buffer length');
});

test('selects native input only for the default Windows TTY stdin', t => {
	const eligible = {
		platform: 'win32' as const,
		isTty: true,
		isDefaultStdin: true,
	};

	t.true(shouldUseWindowsConsoleInput(eligible));
	t.false(shouldUseWindowsConsoleInput({...eligible, mode: 'disabled'}));
	t.false(shouldUseWindowsConsoleInput({...eligible, platform: 'linux'}));
	t.false(shouldUseWindowsConsoleInput({...eligible, isTty: false}));
	t.false(shouldUseWindowsConsoleInput({...eligible, isDefaultStdin: false}));
	t.false(shouldUseWindowsConsoleInput({...eligible, hasStdinListeners: true}));
});

type FakeApiControl = {
	readonly api: WindowsConsoleApi;
	readonly inputModes: number[];
	readonly waitCallbacks: Array<
		Parameters<WindowsConsoleApi['waitForInput']>[2]
	>;
	setInput: (records: readonly TestInputRecord[]) => void;
};

const createFakeApi = (): FakeApiControl => {
	const waitCallbacks: Array<Parameters<WindowsConsoleApi['waitForInput']>[2]> =
		[];
	const inputModes: number[] = [];
	let input = createInputRecords([]);
	let recordCount = 0;

	return {
		api: {
			openInput() {
				return {handle: 'handle', mode: 0x1_f7};
			},
			setInputMode(_handle, mode) {
				inputModes.push(mode);
			},
			restoreInputMode(_handle, mode) {
				inputModes.push(mode);
			},
			waitForInput(_handle, _timeout, callback) {
				waitCallbacks.push(callback);
			},
			getPendingEventCount() {
				return recordCount;
			},
			readInput() {
				return {buffer: input, recordCount};
			},
		},
		inputModes,
		waitCallbacks,
		setInput(records) {
			input = createInputRecords(records);
			recordCount = records.length;
		},
	};
};

test('native backend reads events and keeps one async wait active', async t => {
	const fake = createFakeApi();
	fake.setInput([
		{
			virtualKeyCode: 0x0d,
			virtualScanCode: 0x1c,
			unicodeCodeUnit: 0x0d,
			controlKeyState: windowsConsoleControlKeyState.shift,
		},
	]);
	const events: WindowsConsoleInputEvent[] = [];
	const backend = createWindowsConsoleInput({
		onEvent(event) {
			events.push(event);
		},
		onError() {
			t.fail('Unexpected native input error');
		},
		apiFactory() {
			return fake.api;
		},
	});

	backend.start();
	t.true(backend.isActive());
	t.deepEqual(fake.inputModes, [0x1_f0]);
	t.is(fake.waitCallbacks.length, 1);
	fake.waitCallbacks[0]!(undefined, 'ready');
	await Promise.resolve();

	t.true(getKeyEvents(events)[0]!.keypress.shift);
	t.is(fake.waitCallbacks.length, 2);
	backend.stop();
	t.false(backend.isActive());
	t.deepEqual(fake.inputModes, [0x1_f0, 0x1_f7]);
});

test('native backend ignores a pending wait after stop', t => {
	const fake = createFakeApi();
	fake.setInput([
		{virtualKeyCode: 0x41, virtualScanCode: 0x1e, unicodeCodeUnit: 0x61},
	]);
	const events: WindowsConsoleInputEvent[] = [];
	const backend = createWindowsConsoleInput({
		onEvent(event) {
			events.push(event);
		},
		onError() {
			t.fail('Unexpected native input error');
		},
		apiFactory() {
			return fake.api;
		},
	});

	backend.start();
	backend.stop();
	fake.waitCallbacks[0]!(undefined, 'ready');
	t.deepEqual(events, []);
});

test('native backend reports a runtime wait error and stops', t => {
	const fake = createFakeApi();
	const errors: unknown[] = [];
	const backend = createWindowsConsoleInput({
		onEvent() {
			t.fail('Unexpected native input event');
		},
		onError(error) {
			errors.push(error);
		},
		apiFactory() {
			return fake.api;
		},
	});
	const failure = new Error('console detached');

	backend.start();
	fake.waitCallbacks[0]!(failure);

	t.deepEqual(errors, [failure]);
	t.deepEqual(fake.inputModes, [0x1_f0, 0x1_f7]);
	t.false(backend.isActive());
});

test('native backend surfaces initialization errors to its caller', t => {
	const backend = createWindowsConsoleInput({
		onEvent() {
			t.fail('Unexpected native input event');
		},
		onError() {
			t.fail('Unexpected native input error');
		},
		apiFactory() {
			throw new Error('koffi unavailable');
		},
	});

	const error = t.throws(() => {
		backend.start();
	});
	t.is(error.message, 'koffi unavailable');
	t.false(backend.isActive());
});
