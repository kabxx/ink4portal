import process from 'node:process';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {Buffer} from 'node:buffer';
import React, {useEffect, useState} from 'react';
import {Box, Text, render, useApp} from '../../src/index.js';

type ForeignFunction = (...arguments_: unknown[]) => unknown;
type KoffiModule = {
	load: (path: string) => {func: (definition: string) => ForeignFunction};
	struct: (name: string, fields: Record<string, string | unknown>) => unknown;
};

const require = createRequire(import.meta.url);
const koffi = require('koffi') as KoffiModule;

const kernel32 = koffi.load('kernel32.dll');
const coord = koffi.struct('COORD', {X: 'int16_t', Y: 'int16_t'});
const getStdHandle = kernel32.func('void * __stdcall GetStdHandle(int32_t)');
const readConsoleOutputCharacter = kernel32.func(
	'int32_t __stdcall ReadConsoleOutputCharacterW(void *, _Out_ uint16_t *, uint32_t, COORD, _Out_ uint32_t *)',
);
const snapshotPath = process.argv[2];
const columns = Number(process.argv[3]) || 24;
const rows = Number(process.argv[4]) || 8;

if (!snapshotPath) {
	throw new Error('Snapshot path is required.');
}

process.stdout.columns = columns;
process.stdout.rows = rows;

const readScreen = (): string => {
	const buffer = Buffer.alloc(columns * rows * 2);
	const charactersRead = [0];
	const succeeded = readConsoleOutputCharacter(
		getStdHandle(-11),
		buffer,
		columns * rows,
		{X: 0, Y: 0},
		charactersRead,
	);

	if (!succeeded) {
		throw new Error('ReadConsoleOutputCharacterW failed.');
	}

	return buffer.subarray(0, (charactersRead[0] ?? 0) * 2).toString('utf16le');
};

function Fixture() {
	const {exit} = useApp();
	const [phase, setPhase] = useState(0);

	useEffect(() => {
		const timer = setTimeout(() => {
			if (phase < 4) {
				setPhase(phase + 1);
				return;
			}

			fs.writeFileSync(snapshotPath, readScreen(), 'utf8');
			exit();
		}, 75);

		return () => {
			clearTimeout(timer);
		};
	}, [exit, phase]);

	const label = `STREAM-${phase}`;
	const body = `│ ${label.padEnd(columns - 4, '.')} │`;
	const bottom = `└${'─'.repeat(columns - 2)}┘`;

	return (
		<Box flexDirection="column">
			<Text>{body}</Text>
			<Text>{bottom}</Text>
			<Text>INPUT</Text>
		</Box>
	);
}

render(<Fixture />, {
	incrementalRendering: true,
	reserveTrailingLine: false,
});
