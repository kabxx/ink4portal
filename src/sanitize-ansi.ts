import stringWidth from 'string-width';
import {tokenizeAnsi} from './ansi-tokenizer.js';

const sgrParametersRegex = /^[\d:;]*$/;
const tabWidth = 4;

type SanitizationState = {
	currentLine: string;
	previousWasCarriageReturn: boolean;
};

const isUnsupportedControlCharacter = (character: string): boolean => {
	const codePoint = character.codePointAt(0);
	return (
		codePoint !== undefined &&
		(codePoint <= 0x1f ||
			(codePoint >= 0x7f && codePoint <= 0x9f) ||
			codePoint === 0x20_28 ||
			codePoint === 0x20_29)
	);
};

const sanitizeText = (text: string, state: SanitizationState): string => {
	let output = '';

	for (const character of text) {
		if (character === '\r') {
			output += '\n';
			state.currentLine = '';
			state.previousWasCarriageReturn = true;
			continue;
		}

		if (character === '\n') {
			if (!state.previousWasCarriageReturn) {
				output += character;
			}

			state.currentLine = '';
			state.previousWasCarriageReturn = false;
			continue;
		}

		state.previousWasCarriageReturn = false;

		if (character === '\t') {
			const spaces = tabWidth - (stringWidth(state.currentLine) % tabWidth);
			const expandedTab = ' '.repeat(spaces);
			output += expandedTab;
			state.currentLine += expandedTab;
			continue;
		}

		if (character === '\u000B' || character === '\u000C') {
			output += ' ';
			state.currentLine += ' ';
			continue;
		}

		if (
			character === '\u0085' ||
			character === '\u2028' ||
			character === '\u2029'
		) {
			output += '\n';
			state.currentLine = '';
			continue;
		}

		if (!isUnsupportedControlCharacter(character)) {
			output += character;
			state.currentLine += character;
		}
	}

	return output;
};

const hasUnsafeOscPayloadCharacter = (payload: string): boolean => {
	for (const character of payload) {
		if (isUnsupportedControlCharacter(character)) {
			return true;
		}
	}

	return false;
};

const sanitizeOscHyperlink = (value: string): string | undefined => {
	let payloadStart: number;
	let hasC1Introducer = false;
	if (value.startsWith('\u001B]')) {
		payloadStart = 2;
	} else if (value.startsWith('\u009D')) {
		payloadStart = 1;
		hasC1Introducer = true;
	} else {
		return undefined;
	}

	let payloadEnd: number;
	let hasC1Terminator = false;
	if (value.endsWith('\u001B\\')) {
		payloadEnd = value.length - 2;
	} else if (value.endsWith('\u0007')) {
		payloadEnd = value.length - 1;
	} else if (value.endsWith('\u009C')) {
		payloadEnd = value.length - 1;
		hasC1Terminator = true;
	} else {
		return undefined;
	}

	const payload = value.slice(payloadStart, payloadEnd);
	if (
		!payload.startsWith('8;') ||
		!payload.slice(2).includes(';') ||
		hasUnsafeOscPayloadCharacter(payload)
	) {
		return undefined;
	}

	return hasC1Introducer || hasC1Terminator
		? `\u001B]${payload}\u001B\\`
		: value;
};

export const stripAnsiSequences = (text: string): string => {
	let output = '';

	for (const token of tokenizeAnsi(text)) {
		if (token.type === 'text') {
			output += token.value;
		}
	}

	return output;
};

// Keep text measurement and terminal output in sync by normalizing control
// characters and preserving only layout-safe ANSI sequences.
const sanitizeAnsi = (text: string): string => {
	let output = '';
	const state: SanitizationState = {
		currentLine: '',
		previousWasCarriageReturn: false,
	};

	for (const token of tokenizeAnsi(text)) {
		if (token.type === 'text') {
			output += sanitizeText(token.value, state);
			continue;
		}

		if (token.type === 'c1' && token.value === '\u0085') {
			output += '\n';
			state.currentLine = '';
			state.previousWasCarriageReturn = false;
			continue;
		}

		if (token.type === 'osc') {
			const hyperlink = sanitizeOscHyperlink(token.value);
			if (hyperlink !== undefined) {
				output += hyperlink;
			}

			continue;
		}

		if (
			token.type === 'csi' &&
			token.finalCharacter === 'm' &&
			token.intermediateString === '' &&
			sgrParametersRegex.test(token.parameterString)
		) {
			output += token.value.startsWith('\u009B')
				? `\u001B[${token.value.slice(1)}`
				: token.value;
		}
	}

	return output;
};

export default sanitizeAnsi;
