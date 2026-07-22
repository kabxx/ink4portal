import {type Writable} from 'node:stream';
import ansiEscapes from 'ansi-escapes';
import cliCursor from 'cli-cursor';
import stringWidth from 'string-width';
import {
	type CursorPosition,
	cursorPositionChanged,
	buildCursorSuffix,
	buildCursorOnlySequence,
	buildReturnToBottomPrefix,
	hideCursorEscape,
} from './cursor-helpers.js';

export type {CursorPosition} from './cursor-helpers.js';

export type LogUpdate = {
	clear: () => void;
	done: () => void;
	reset: () => void;
	sync: (str: string, options?: {stabilizeRightMargin?: boolean}) => void;
	setCursorPosition: (position: CursorPosition | undefined) => void;
	isCursorDirty: () => boolean;
	willRender: (str: string) => boolean;
	(str: string): boolean;
};

type LogUpdateOptions = {
	showCursor?: boolean;
	incremental?: boolean;
	getTerminalWidth?: () => number;
};

type SyncOptions = {stabilizeRightMargin?: boolean};

// A full-width final row leaves Windows consoles in wrap-pending. Returning to
// column zero keeps the same pixels while preventing the next frame from scrolling.
const rightMarginReset = (
	output: string,
	terminalWidth: number | undefined,
): string => {
	if (
		terminalWidth === undefined ||
		terminalWidth <= 0 ||
		output === '' ||
		output.endsWith('\n') ||
		output.endsWith('\r')
	) {
		return '';
	}

	const lastLine = output.slice(output.lastIndexOf('\n') + 1);
	const width = stringWidth(lastLine);
	return width >= terminalWidth && width % terminalWidth === 0 ? '\r' : '';
};

export const stabilizeRightMargin = (
	output: string,
	terminalWidth: number | undefined,
): string => `${output}${rightMarginReset(output, terminalWidth)}`;

const cursorAnchorLine = (output: string, visibleCount: number): number =>
	output.endsWith('\n') ? visibleCount : Math.max(0, visibleCount - 1);

const buildOutputSuffix = (
	output: string,
	visibleCount: number,
	cursorPosition: CursorPosition | undefined,
	getTerminalWidth: (() => number) | undefined,
): string => {
	const reset = rightMarginReset(output, getTerminalWidth?.());
	const cursorAnchor = cursorAnchorLine(output, visibleCount);
	return reset + buildCursorSuffix(cursorAnchor, cursorPosition);
};

// Count visible lines in a string, ignoring the trailing empty element
// that `split('\n')` produces when the string ends with '\n'.
const visibleLineCount = (lines: string[], str: string): number =>
	str.endsWith('\n') ? lines.length - 1 : lines.length;

const createStandard = (
	stream: Writable,
	{showCursor = false, getTerminalWidth}: LogUpdateOptions = {},
): LogUpdate => {
	let previousLineCount = 0;
	let previousOutput = '';
	let hasHiddenCursor = false;
	let cursorPosition: CursorPosition | undefined;
	let cursorDirty = false;
	let previousCursorPosition: CursorPosition | undefined;
	let cursorWasShown = false;

	const getActiveCursor = () => (cursorDirty ? cursorPosition : undefined);
	const hasChanges = (
		str: string,
		activeCursor: CursorPosition | undefined,
	): boolean => {
		const cursorChanged = cursorPositionChanged(
			activeCursor,
			previousCursorPosition,
		);
		return str !== previousOutput || cursorChanged;
	};

	const render = (str: string) => {
		if (!showCursor && !hasHiddenCursor) {
			cliCursor.hide(stream);
			hasHiddenCursor = true;
		}

		// Only use cursor if setCursorPosition was called since last render.
		// This ensures stale positions don't persist after component unmount.
		const activeCursor = getActiveCursor();
		cursorDirty = false;
		const cursorChanged = cursorPositionChanged(
			activeCursor,
			previousCursorPosition,
		);

		if (!hasChanges(str, activeCursor)) {
			return false;
		}

		const lines = str.split('\n');
		const visibleCount = visibleLineCount(lines, str);
		const outputSuffix = buildOutputSuffix(
			str,
			visibleCount,
			activeCursor,
			getTerminalWidth,
		);

		if (str === previousOutput && cursorChanged) {
			stream.write(
				buildCursorOnlySequence({
					cursorWasShown,
					previousLineCount,
					previousCursorPosition,
					visibleLineCount: cursorAnchorLine(str, visibleCount),
					cursorPosition: activeCursor,
				}),
			);
		} else {
			previousOutput = str;
			const returnPrefix = buildReturnToBottomPrefix(
				cursorWasShown,
				previousLineCount,
				previousCursorPosition,
			);
			stream.write(
				returnPrefix +
					ansiEscapes.eraseLines(previousLineCount) +
					str +
					outputSuffix,
			);
			previousLineCount = lines.length;
		}

		previousCursorPosition = activeCursor ? {...activeCursor} : undefined;
		cursorWasShown = activeCursor !== undefined;
		return true;
	};

	render.clear = () => {
		const prefix = buildReturnToBottomPrefix(
			cursorWasShown,
			previousLineCount,
			previousCursorPosition,
		);
		stream.write(prefix + ansiEscapes.eraseLines(previousLineCount));
		previousOutput = '';
		previousLineCount = 0;
		previousCursorPosition = undefined;
		cursorWasShown = false;
	};

	render.done = () => {
		previousOutput = '';
		previousLineCount = 0;
		previousCursorPosition = undefined;
		cursorWasShown = false;

		if (!showCursor) {
			cliCursor.show(stream);
			hasHiddenCursor = false;
		}
	};

	render.reset = () => {
		previousOutput = '';
		previousLineCount = 0;
		previousCursorPosition = undefined;
		cursorWasShown = false;
	};

	render.sync = (str: string, options: SyncOptions = {}) => {
		const activeCursor = cursorDirty ? cursorPosition : undefined;
		cursorDirty = false;

		const lines = str.split('\n');
		previousOutput = str;
		previousLineCount = lines.length;

		if (!activeCursor && cursorWasShown) {
			stream.write(hideCursorEscape);
		}

		const visibleCount = visibleLineCount(lines, str);
		const outputSuffix = options.stabilizeRightMargin
			? buildOutputSuffix(str, visibleCount, activeCursor, getTerminalWidth)
			: buildCursorSuffix(cursorAnchorLine(str, visibleCount), activeCursor);
		if (outputSuffix !== '') {
			stream.write(outputSuffix);
		}

		previousCursorPosition = activeCursor ? {...activeCursor} : undefined;
		cursorWasShown = activeCursor !== undefined;
	};

	render.setCursorPosition = (position: CursorPosition | undefined) => {
		cursorPosition = position;
		cursorDirty = true;
	};

	render.isCursorDirty = () => cursorDirty;
	render.willRender = (str: string) => hasChanges(str, getActiveCursor());

	return render;
};

const createIncremental = (
	stream: Writable,
	{showCursor = false, getTerminalWidth}: LogUpdateOptions = {},
): LogUpdate => {
	let previousLines: string[] = [];
	let previousOutput = '';
	let hasHiddenCursor = false;
	let cursorPosition: CursorPosition | undefined;
	let cursorDirty = false;
	let previousCursorPosition: CursorPosition | undefined;
	let cursorWasShown = false;

	const getActiveCursor = () => (cursorDirty ? cursorPosition : undefined);
	const hasChanges = (
		str: string,
		activeCursor: CursorPosition | undefined,
	): boolean => {
		const cursorChanged = cursorPositionChanged(
			activeCursor,
			previousCursorPosition,
		);
		return str !== previousOutput || cursorChanged;
	};

	const render = (str: string) => {
		if (!showCursor && !hasHiddenCursor) {
			cliCursor.hide(stream);
			hasHiddenCursor = true;
		}

		// Only use cursor if setCursorPosition was called since last render.
		// This ensures stale positions don't persist after component unmount.
		const activeCursor = getActiveCursor();
		cursorDirty = false;
		const cursorChanged = cursorPositionChanged(
			activeCursor,
			previousCursorPosition,
		);

		if (!hasChanges(str, activeCursor)) {
			return false;
		}

		const nextLines = str.split('\n');
		const visibleCount = visibleLineCount(nextLines, str);
		const previousVisible = visibleLineCount(previousLines, previousOutput);

		if (str === previousOutput && cursorChanged) {
			stream.write(
				buildCursorOnlySequence({
					cursorWasShown,
					previousLineCount: previousLines.length,
					previousCursorPosition,
					visibleLineCount: cursorAnchorLine(str, visibleCount),
					cursorPosition: activeCursor,
				}),
			);
			previousCursorPosition = activeCursor ? {...activeCursor} : undefined;
			cursorWasShown = activeCursor !== undefined;
			return true;
		}

		const returnPrefix = buildReturnToBottomPrefix(
			cursorWasShown,
			previousLines.length,
			previousCursorPosition,
		);

		if (str === '\n' || previousOutput.length === 0) {
			const outputSuffix = buildOutputSuffix(
				str,
				visibleCount,
				activeCursor,
				getTerminalWidth,
			);
			stream.write(
				returnPrefix +
					ansiEscapes.eraseLines(previousLines.length) +
					str +
					outputSuffix,
			);
			cursorWasShown = activeCursor !== undefined;
			previousCursorPosition = activeCursor ? {...activeCursor} : undefined;
			previousOutput = str;
			previousLines = nextLines;
			return true;
		}

		const hasTrailingNewline = str.endsWith('\n');

		// We aggregate all chunks for incremental rendering into a buffer, and then write them to stdout at the end.
		const buffer: string[] = [];

		buffer.push(returnPrefix);

		// Clear extra lines if the current content's line count is lower than the previous.
		if (visibleCount < previousVisible) {
			const previousHadTrailingNewline = previousOutput.endsWith('\n');
			const extraSlot = previousHadTrailingNewline ? 1 : 0;
			buffer.push(
				ansiEscapes.eraseLines(previousVisible - visibleCount + extraSlot),
				ansiEscapes.cursorUp(visibleCount),
			);
		} else {
			buffer.push(ansiEscapes.cursorUp(previousLines.length - 1));
		}

		for (let i = 0; i < visibleCount; i++) {
			const isLastLine = i === visibleCount - 1;

			// We do not write lines if the contents are the same. This prevents flickering during renders.
			if (nextLines[i] === previousLines[i]) {
				// Don't move past the last line when there's no trailing newline,
				// otherwise the cursor overshoots the rendered block.
				if (!isLastLine || hasTrailingNewline) {
					buffer.push(ansiEscapes.cursorNextLine);
				}

				continue;
			}

			buffer.push(
				ansiEscapes.cursorTo(0) +
					nextLines[i] +
					ansiEscapes.eraseEndLine +
					// Don't append newline after the last line when the input
					// has no trailing newline (fullscreen mode).
					(isLastLine && !hasTrailingNewline ? '' : '\n'),
			);
		}

		buffer.push(
			buildOutputSuffix(str, visibleCount, activeCursor, getTerminalWidth),
		);

		stream.write(buffer.join(''));

		cursorWasShown = activeCursor !== undefined;
		previousCursorPosition = activeCursor ? {...activeCursor} : undefined;
		previousOutput = str;
		previousLines = nextLines;
		return true;
	};

	render.clear = () => {
		const prefix = buildReturnToBottomPrefix(
			cursorWasShown,
			previousLines.length,
			previousCursorPosition,
		);
		stream.write(prefix + ansiEscapes.eraseLines(previousLines.length));
		previousOutput = '';
		previousLines = [];
		previousCursorPosition = undefined;
		cursorWasShown = false;
	};

	render.done = () => {
		previousOutput = '';
		previousLines = [];
		previousCursorPosition = undefined;
		cursorWasShown = false;

		if (!showCursor) {
			cliCursor.show(stream);
			hasHiddenCursor = false;
		}
	};

	render.reset = () => {
		previousOutput = '';
		previousLines = [];
		previousCursorPosition = undefined;
		cursorWasShown = false;
	};

	render.sync = (str: string, options: SyncOptions = {}) => {
		const activeCursor = cursorDirty ? cursorPosition : undefined;
		cursorDirty = false;

		const lines = str.split('\n');
		previousOutput = str;
		previousLines = lines;

		if (!activeCursor && cursorWasShown) {
			stream.write(hideCursorEscape);
		}

		const visibleCount = visibleLineCount(lines, str);
		const outputSuffix = options.stabilizeRightMargin
			? buildOutputSuffix(str, visibleCount, activeCursor, getTerminalWidth)
			: buildCursorSuffix(cursorAnchorLine(str, visibleCount), activeCursor);
		if (outputSuffix !== '') {
			stream.write(outputSuffix);
		}

		previousCursorPosition = activeCursor ? {...activeCursor} : undefined;
		cursorWasShown = activeCursor !== undefined;
	};

	render.setCursorPosition = (position: CursorPosition | undefined) => {
		cursorPosition = position;
		cursorDirty = true;
	};

	render.isCursorDirty = () => cursorDirty;
	render.willRender = (str: string) => hasChanges(str, getActiveCursor());

	return render;
};

const create = (
	stream: Writable,
	{
		showCursor = false,
		incremental = false,
		getTerminalWidth,
	}: LogUpdateOptions = {},
): LogUpdate => {
	if (incremental) {
		return createIncremental(stream, {showCursor, getTerminalWidth});
	}

	return createStandard(stream, {showCursor, getTerminalWidth});
};

const logUpdate = {create};
export default logUpdate;
