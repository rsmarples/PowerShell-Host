import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';

/**
 * @typedef {Object} PowerShellOptions
 * @property {string} [shell]
 * @property {string[]} [args]
 * @property {boolean} log
 */
const defaultOptions = {
    shell: 'PowerShell',
    args: [],
    log: false,
};

/**
 * Output formatter to write Exceptions to StdErr.
 * We only write the Message because that's the only real thing of use.
 * Anything else would only be useful for people debugging any aplets or programs used,
 * but that would be done better outside of this library.
 */
const outDefault = `
function Out-Default {
    [CmdletBinding()]
    param (
      [Parameter(ValueFromPipeline = $true)]
      $o
    )
    if ($o -is [System.Exception]) {
      [Console]::Error.WriteLine($o.Message);
    } elseif ($o -is [System.Management.Automation.ErrorRecord]) {
      [Console]::Error.WriteLine($o.Exception.Message);
    } else {
      Write-Host($o);
    }
}
`;

// Sets the PowerShell prompt to be always PS>
const prompt = `
    function prompt { return "" }
`;

/**
 * @callback ResolveCallback
 * @param {string | PromiseLike<string>} value
 * @returns {void}
 */

/**
 * @callback RejectCallback
 * @param {any} [reason]
 * @returns {void}
 */

/**
 * @typedef {Object} PowerShellCmd
 * @property {string} cmd
 * @property {ResolveCallback} resolve
 * @property {RejectCallback} reject
 * @property {number?} timeout
 * @property {number} timeoutId
 */

export class PowerShellError extends Error {
}
export class PowerShellTimeout extends PowerShellError {
}

/**
 * Hosts a PowerShell process where you can send commands and receive data back.
 */
export class PowerShell extends EventEmitter {
    /** @type {ChildProcess | undefined} */
    #child;
    #spawned = false;
    #inited = false;
    /** @type {string} */
    #stdout = '';
    /** @type {string} */
    #stderr = '';
    /** @type {PowerShellCmd} */
    #cmd;
    /** @type {PowerShellCmd[]} */
    #cmdQueue = [];
    /** @type {boolean} */
    #log = false;

    /**
     * Spawns a PowerShell process.
     * You can only have one of these.
     * Call close() once finished to kill the PowerShell process.
     * Consumers should listen to the `error` event which could be raised before the shell
     * has fully initialised as this could happen after the open promise has been resolved.
     *
     * @param {PowerShellOptions} [options] PowerShell options
     * @returns {Promise<void>}
     */
    open(options) {
        const opts = {
            ...defaultOptions,
            ...options,
        };
        this.#stdout = '';
        this.#stderr = '';
        this.#log = opts.log;

        return new Promise((resolve, reject) => {
            const ps = this;

            if (ps.#child) {
                reject(new PowerShellError('already spawned something'));
                return;
            }

            ps.#child = spawn(opts.shell, opts.args);
            if (!ps.#child) {
                reject(new PowerShellError('shell failed to spawn'));
                return;
            }

            ps.#child.on('spawn', function () {
                ps.#spawned = true;
                resolve();
            });
            this.#child.on('error', function (err) {
                if (!ps.#spawned) {
                    ps.#child.removeAllListeners();
                    ps.#child = undefined;
                    reject(err);
                    return;
                }
                ps.emit('error', err);
            });
            this.#child.on('exit', (code, signal) => {
                ps.#child.removeAllListeners();
                ps.#child = undefined;

                if (this.#stderr) {
                    const err = new PowerShellError(ps.#stderr);
                    ps.#stderr = '';
                    ps.emit('error', err);
                }

                // The client can remove the listener when closing to avoid this emit
                ps.emit('exit', code, signal);

                // We need to reject the pending queue
                /** @type {PowerShellCmd} */
                let q;
                while ((q = this.#cmdQueue.shift())) {
                    q.reject(new PowerShellError('shell exited'));
                }
            });

            this.#child.stdout.on('data', function (chunk) {
                ps.#processStdOut(chunk);
            });
            this.#child.stderr.on('data', function (chunk) {
                ps.#processStdErr(chunk);
            });

            try {
                this.#child.stdin.write(`${outDefault}${prompt}`);
            } catch (err) {
                reject(err);
            }
        });
    }

    #popQueue() {
        this.#stderr = '';
        this.#stdout = '';
        this.#cmd = this.#cmdQueue.shift();
        if (!this.#cmd) {
            return;
        }

        const ps = this;
        const cmd = ps.#cmd;
        if (cmd.timeout) {
            cmd.timeoutId = setTimeout(() => {
                cmd.timeoutId = undefined;
                // XXX We neet to send CTRL-C somehow
                ps.#popQueue();
                cmd.reject(new PowerShellTimeout(`exec timeout: ${cmd.cmd.trimEnd()}`));
            }, cmd.timeout);
        }
        if (this.#log) {
            console.log(`exec: ${cmd.cmd.trimEnd()}`);
        }
        this.#child.stdin.write(`${cmd.cmd}`, function (error) {
            if (error) {
                ps.#popQueue();
                cmd.reject(new PowerShellError(error));
            }
        });
    }

    #reject(err) {
        const cmd = this.#cmd;
        if (!cmd) {
            console.log(`nowhere for this error to go: ${err}`);
            this.#popQueue();
            return;
        }

        const rej = cmd.reject;
        if (cmd.timeoutId) {
            clearTimeout(cmd.timeoutId);
        }
        if (this.#log) {
            console.log(`exec rejected: ${cmd.cmd.trimEnd()}: ${err}`);
        }
        this.#popQueue();
        rej(err);
    }

    #resolveCmd() {
        if (this.#stderr) {
            const err = this.#stderr.trim();
            this.#reject(err);
            return;
        }

        // The command is always echoed on the shell console. We need to trim it, and thus validate it.
        const cmd = this.#cmd;
        if (!this.#stdout.startsWith(cmd.cmd)) {
            this.#reject(new PowerShellError(`data does not start with command: ${cmd.cmd}`));
            return;
        }

        const result = this.#stdout.substring(cmd.cmd.length).trimEnd();
        const resolve = cmd.resolve;
        if (cmd.timeoutId) {
            clearTimeout(cmd.timeoutId);
        }
        if (this.#log) {
            console.log(`exec completed: ${cmd.cmd.trimEnd()}`);
        }
        this.#popQueue();
        resolve(result);
    }

    #processStdOut(chunk) {
        const data = chunk.toString();
        if (data === 'PS>') {
            if (!this.#inited) {
                this.#inited = true;
                this.#popQueue();
            } else {
                this.#resolveCmd();
            }
        } else if (this.#inited) {
            this.#stdout += data;
        }
    }

    #processStdErr(chunk) {
        const data = chunk.toString();
        this.#stderr += data;
    }

    /**
     * Executes the command.
     * Any Exception or ExceptionRecord will emit the Message on the Exception to stderr.
     * Any output on stderr will be rejected.
     * Otherwise any output on stdout will be resolved as a string.
     * You could pipe your output the PowerShell applet ConvertTo-Json at the end of your
     * command and then use JSON.parse() on the string you can back, or do your own thing.
     *
     * @param {string} cmd The command to execute
     * @param {number?} timeout Maximum time for command to execute in ms
     * @returns {Promise<string>}
     */
    exec(cmd, timeout) {
        if (!this.#child) {
            throw new PowerShellError('No open shell to execute commands');
        }
        return new Promise((resolve, reject) => {
            /** @type {PowerShellCmd} */
            const q = {
                cmd: cmd.trim() + '\n',
                resolve: resolve,
                reject: reject,
                timeoutId: undefined,
                timeout: timeout,
            };
            this.#cmdQueue = [...this.#cmdQueue, q];
            if (!this.#cmd && this.#inited) {
                this.#popQueue();
            }
        });
    }

    /**
     * Kill any child process.
     *
     * @returns {boolean} Returns true if we notified the shell to exist, otherwise false.
     */
    close() {
        return this.#child?.kill() ?? false;
    }

    /**
     * Returns true if we have a PowerShell open
     *
     * @returns {boolean}
     */
    isOpen() {
        return !!this.#child;
    }
}
