import {nonAlphanumericKeys, type ParsedKey} from './parse-keypress.js';

/**
 * A key event produced by an input backend that already knows the key's
 * modifiers.  The public `useInput` shape is derived from `keypress` in one
 * place so every backend follows the same input semantics.
 */
export type InputKeyEvent = {
	readonly type: 'key';
	readonly keypress: ParsedKey;
};

export type InternalInputEvent = string | InputKeyEvent;

/**
 * Keep the conversion from a parsed terminal key to the `input` argument
 * shared by byte-oriented and native input backends.
 */
export const getInputFromKeypress = (keypress: ParsedKey): string => {
	let input: string;
	const isStructuredInput =
		keypress.isKittyProtocol === true || keypress.isStructuredInput === true;

	if (isStructuredInput) {
		// Use text-as-codepoints for printable keys and suppress non-printable
		// function/modifier keys. Ctrl+letter still exposes its letter name so
		// exitOnCtrlC and custom Ctrl shortcuts work consistently.
		if (keypress.isPrintable) {
			input = keypress.text ?? keypress.name;
		} else if (keypress.ctrl && keypress.name.length === 1) {
			input = keypress.name;
		} else {
			input = '';
		}
	} else if (keypress.ctrl) {
		input = keypress.name ?? '';
	} else {
		input = keypress.sequence;
	}

	if (!isStructuredInput && nonAlphanumericKeys.includes(keypress.name)) {
		input = '';
	}

	// A timed-out/incomplete escape is literal input after the parser flushes
	// it. Do not expose the escape prefix as part of the character.
	if (input.startsWith('\u001B')) {
		input = input.slice(1);
	}

	return input;
};
