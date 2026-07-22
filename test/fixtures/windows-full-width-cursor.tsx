import process from 'node:process';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import React, {useEffect, useState} from 'react';
import {Text, render, useApp, useCursor} from '../../src/index.js';

type ForeignFunction = (...arguments_: unknown[]) => unknown;
type KoffiModule = {
	load: (path: string) => {func: (definition: string) => ForeignFunction};
	struct: (name: string, fields: Record<string, string | unknown>) => unknown;
};

const require = createRequire(import.meta.url);
const koffi = require('koffi') as KoffiModule;

const kernel32 = koffi.load('kernel32.dll');
const coord = koffi.struct('COORD', {X: 'int16_t', Y: 'int16_t'});
const rect = koffi.struct('SMALL_RECT', {
	Left: 'int16_t',
	Top: 'int16_t',
	Right: 'int16_t',
	Bottom: 'int16_t',
});
koffi.struct('CONSOLE_SCREEN_BUFFER_INFO', {
	dwSize: coord,
	dwCursorPosition: coord,
	wAttributes: 'uint16_t',
	srWindow: rect,
	dwMaximumWindowSize: coord,
});
const getStdHandle = kernel32.func('void * __stdcall GetStdHandle(int32_t)');
const getInfo = kernel32.func(
	'int32_t __stdcall GetConsoleScreenBufferInfo(void *, _Out_ CONSOLE_SCREEN_BUFFER_INFO *)',
);
const snapshotPath = process.argv[2];

if (!snapshotPath) {
	throw new Error('Snapshot path is required.');
}

process.stdout.columns = 5;
process.stdout.rows = 3;

function Fixture() {
	const {exit} = useApp();
	const {setCursorPosition} = useCursor();
	const [showCursor, setShowCursor] = useState(false);
	setCursorPosition(showCursor ? {x: 2, y: 0} : undefined);

	useEffect(() => {
		const timer = setTimeout(() => {
			setShowCursor(true);
		}, 75);

		return () => {
			clearTimeout(timer);
		};
	}, []);

	useEffect(() => {
		if (!showCursor) return;

		const timer = setTimeout(() => {
			const info: {dwCursorPosition?: {X?: number; Y?: number}} = {};
			getInfo(getStdHandle(-11), info);
			fs.writeFileSync(snapshotPath, JSON.stringify(info.dwCursorPosition));
			exit();
		}, 150);

		return () => {
			clearTimeout(timer);
		};
	}, [exit, showCursor]);

	return <Text>12345</Text>;
}

render(<Fixture />, {reserveTrailingLine: false});
