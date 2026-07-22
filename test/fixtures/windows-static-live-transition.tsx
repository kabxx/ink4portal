import process from 'node:process';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {Buffer} from 'node:buffer';
import React, {useEffect, useState} from 'react';
import {Box, Static, Text, render, useApp} from '../../src/index.js';

type ForeignFunction = (...arguments_: unknown[]) => unknown;

type KoffiModule = {
	load: (path: string) => {
		func: (definition: string) => ForeignFunction;
	};
	struct: (name: string, fields: Record<string, string | unknown>) => unknown;
};

const require = createRequire(import.meta.url);
const koffi = require('koffi') as KoffiModule;

const kernel32 = koffi.load('kernel32.dll');
const coord = koffi.struct('COORD', {X: 'int16_t', Y: 'int16_t'});
const smallRect = koffi.struct('SMALL_RECT', {
	Left: 'int16_t',
	Top: 'int16_t',
	Right: 'int16_t',
	Bottom: 'int16_t',
});
koffi.struct('CONSOLE_SCREEN_BUFFER_INFO', {
	dwSize: coord,
	dwCursorPosition: coord,
	wAttributes: 'uint16_t',
	srWindow: smallRect,
	dwMaximumWindowSize: coord,
});
const getStdHandle = kernel32.func(
	'void * __stdcall GetStdHandle(int32_t nStdHandle)',
);
const getConsoleScreenBufferInfo = kernel32.func(
	'int32_t __stdcall GetConsoleScreenBufferInfo(void *hConsoleOutput, _Out_ CONSOLE_SCREEN_BUFFER_INFO *lpConsoleScreenBufferInfo)',
);
const readConsoleOutputCharacter = kernel32.func(
	'int32_t __stdcall ReadConsoleOutputCharacterW(void *hConsoleOutput, _Out_ uint16_t *lpCharacter, uint32_t nLength, COORD dwReadCoord, _Out_ uint32_t *lpNumberOfCharsRead)',
);

const standardOutputHandle = -11;
const snapshotPath = process.argv[2];
const columns = Number(process.argv[3]) || 124;
const rows = Number(process.argv[4]) || 40;

if (!snapshotPath) {
	throw new Error('Snapshot path is required.');
}

process.stdout.columns = columns;
process.stdout.rows = rows;

const readScreen = (): string => {
	const characterCount = columns * rows;
	const buffer = Buffer.alloc(characterCount * 2);
	const charactersRead = [0];
	const succeeded = readConsoleOutputCharacter(
		getStdHandle(standardOutputHandle),
		buffer,
		characterCount,
		{X: 0, Y: 0},
		charactersRead,
	);

	if (!succeeded) {
		throw new Error('ReadConsoleOutputCharacterW failed.');
	}

	return buffer.subarray(0, (charactersRead[0] ?? 0) * 2).toString('utf16le');
};

const readCursorPosition = (): {X: number; Y: number} => {
	const info: {dwCursorPosition?: {X?: number; Y?: number}} = {};
	const succeeded = getConsoleScreenBufferInfo(
		getStdHandle(standardOutputHandle),
		info,
	);

	if (!succeeded) {
		throw new Error('GetConsoleScreenBufferInfo failed.');
	}

	return {
		X: info.dwCursorPosition?.X ?? -1,
		Y: info.dwCursorPosition?.Y ?? -1,
	};
};

const fillLine = (label: string, fill: string): string =>
	`${label}${fill.repeat(Math.max(0, columns - label.length))}`;
const history = Array.from({length: rows - 8}, (_, index) =>
	fillLine(`HISTORY-${index}`, 'H'),
);
const fullWidthLiveLine = fillLine('LIVE-', 'L');
const fullWidthFinalLine = fillLine('FINAL-', 'F');

function Fixture() {
	const {exit} = useApp();
	const [completed, setCompleted] = useState(false);

	useEffect(() => {
		const timer = setTimeout(() => {
			if (!completed) {
				setCompleted(true);
				return;
			}

			fs.writeFileSync(
				snapshotPath,
				JSON.stringify({screen: readScreen(), cursor: readCursorPosition()}),
				'utf8',
			);
			exit();
		}, 150);

		return () => {
			clearTimeout(timer);
		};
	}, [completed, exit]);

	const staticItems = completed
		? [...history, fullWidthFinalLine, fillLine('FINAL-BODY', 'F')]
		: history;

	return (
		<>
			<Static items={staticItems}>
				{item => <Text key={item}>{item}</Text>}
			</Static>
			<Box flexDirection="column">
				{completed ? null : (
					<>
						<Text>{fullWidthLiveLine}</Text>
						{Array.from({length: 10}, (_, index) => (
							<Text key={index}>{fillLine(`LIVE-BODY-${index}`, 'L')}</Text>
						))}
						<Text>{fillLine('LIVE-BOTTOM', 'L')}</Text>
					</>
				)}
				<Text>{fillLine('INPUT-TOP', 'I')}</Text>
				<Text>{fillLine('INPUT-BOTTOM', 'I')}</Text>
			</Box>
		</>
	);
}

render(<Fixture />, {reserveTrailingLine: false});
