import * as vscode from 'vscode';
import { LoggingDebugSession, InitializedEvent, TerminatedEvent } from 'vscode-debugadapter';
import { EventEmitter } from 'events';
import { ChildProcess, exec, execFile, spawn } from 'child_process';
import { OutputChannel } from 'vscode';
import { Readable } from 'stream';
import { host } from '../host';
import { shell } from '../shell';
import { fs } from '../fs';
import { create as draftCreate, CheckPresentMode } from './draft';
import { installDependencies } from '../extension';

export class DraftRuntime extends EventEmitter {
	private _draft = draftCreate(host, fs, shell, installDependencies);
	private _connectProccess: ChildProcess;

	constructor() {
		super();
	}

	public killConnect() {
		this._connectProccess.kill('SIGTERM');
	}

	public async draftUpDebug(config: vscode.DebugConfiguration) {

		let output = vscode.window.createOutputChannel("draft");
		output.show();

		let isPresent = await this._draft.checkPresent(CheckPresentMode.Alert);
		if (!isPresent) {
			host.showInformationMessage("Draft is not installed!");
			return;
		}

		if (!this._draft.isFolderMapped(vscode.workspace.rootPath)) {
			host.showErrorMessage("This folder does not contain a Draft app. Run draft create first!");
			return;
		}

		// //wait for `draft up` to finish
		await waitForProcessToExit(createProcess('draft', ['up'], output));

		// wait for `draft connect` to be ready
		this._connectProccess = createProcess('draft', ['connect'], output);
		await waitConnectionReady(this._connectProccess, config);

		host.showInformationMessage(`attaching debugger`);

		vscode.debug.startDebugging(undefined, config['original-debug']);
		vscode.debug.onDidTerminateDebugSession((e) => {
			this.killConnect();
			output.dispose();
		});
	}
}

function createProcess(cmd: string, args: string[], output: OutputChannel): ChildProcess {
	// notify that cmd started
	console.log(`started ${cmd} ${args.toString()}`);
	host.showInformationMessage(`starting ${cmd} ${args.toString()}`);

	let proc = spawn(cmd, args, { cwd: vscode.workspace.rootPath });
	console.log(process.env.PATH);
	// output data on the tab
	subscribeToDataEvent(proc.stdout, output);
	subscribeToDataEvent(proc.stderr, output);

	proc.on('exit', (code) => {
		host.showInformationMessage(`finished ${cmd} ${args.toString()}`);
		console.log(`finished ${cmd} ${args.toString()} with exit code ${code}`);
	});
	return proc;
}

async function waitForProcessToExit(proc: ChildProcess): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		proc.addListener('message', (message) => { console.log(message); });
		proc.addListener('close', (code, signal) => { console.log(`Code: ${code}, Signal: ${signal}`); });
		proc.addListener('disconnect', () => console.log('disconnected'));
		proc.addListener('error', (err) => { console.log(`Error: ${err}`); });
		proc.addListener('exit', resolve);
	});
}

// TODO - wait for specific stdout output based on debugger type
async function waitConnectionReady(proc: ChildProcess, config: vscode.DebugConfiguration): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let isConnectionReady: boolean = false;

		proc.stdout.on('data', async (data: string) => {
			if ((!isConnectionReady) && canAttachDebugger(data, config)) {
				isConnectionReady = true;
				resolve();
			}
		});

		proc.on('close', async (code) => {
			if (!isConnectionReady) {
				reject('Cannot connect.');
			}
		});
	});
}

// TODO - add other debugger type outputs here
function canAttachDebugger(data: string, config: vscode.DebugConfiguration): boolean {
	switch (config['original-debug'].type) {
		case 'node': {
			if (config['original-debug'].localRoot == '' || config['original-debug'].localRoot == null) {
				config['original-debug'].localRoot = vscode.workspace.rootPath;
			}
			if (data.indexOf('Debugger listening') >= 0)
				return true;
		}

		case 'go': {
			if (config["original-debug"].program == '' || config["original-debug"].program == null) {
				config['original-debug'].program = vscode.workspace.rootPath;
			}
			if (data.indexOf('API server listening') >= 0)
				return true;
		}
	}
}

function subscribeToDataEvent(readable: Readable, outputChannel: OutputChannel): void {
	readable.on('data', (chunk) => {
		const chunkAsString = typeof chunk === 'string' ? chunk : chunk.toString();
		outputChannel.append(chunkAsString);
	});
}
