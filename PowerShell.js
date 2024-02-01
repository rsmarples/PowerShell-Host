import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';

/**
 * @typedef {Object} PowerShellOptions
 * @property {string} [shell]
 * @property {string[]} [args]
 */
const defaultOptions = {
    shell: 'PowerShell',
    args: [],
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
 */

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

    /**
     * Spawns a PowerShell process.
     * You can only have one of these.
     * Call deinit() once finished to kill the PowerShell process.
     *
     * @param {PowerShellOptions} [options] PowerShell options
     * @returns {Promise<void>}
     */
    init(options) {
        const opts = {
            ...defaultOptions,
            ...options,
        };
        return new Promise((resolve, reject) => {
            const ps = this;

            if (ps.#child) {
                reject(new Error('already spawned something'));
                return;
            }

            ps.#child = spawn(opts.shell, ['-NoLogo', opts.args]);
            if (!ps.#child) {
                reject(new Error('shell failed to spawn'));
                return;
            }

            ps.#child.on('spawn', function () {
                ps.#spawned = true;
                resolve();
            });
            this.#child.on('error', function (err) {
                if (!ps.#spawned) {
                    ps.#child = undefined;
                    reject(err);
                    return;
                }
                ps.emit('error', err);
            });

            this.#child.stdout.on('data', function (chunk) {
                ps.#processStdOut(chunk);
            });
            this.#child.stderr.on('data', function (chunk) {
                ps.#processStdErr(chunk);
            });

            this.#child.stdin.write(`${outDefault}${prompt}`);
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
        this.#child.stdin.write(`${cmd.cmd}`, function (error) {
            if (error) {
                ps.#popQueue();
                cmd.reject(error);
            }
        });
    }

    #reject(err) {
        const rej = this.#cmd.reject;
        rej(new Error(err));
        this.#popQueue();
    }

    #resolveCmd() {
        if (this.#stderr) {
            const err = this.#stderr.trim();
            this.#reject(err);
            return;
        }

        // The command is always echoed on the shell console. We need to trim it, and thus validate it.
        const cmd = this.#cmd.cmd;
        if (!this.#stdout.startsWith(cmd)) {
            this.#reject(new Error(`data does not start with command: ${cmd}`));
            return;
        }

        const result = this.#stdout.substring(cmd.length).trimEnd();
        const resolve = this.#cmd.resolve;
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
        this.#stderr += chunk.toString();
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
     * @returns {Promise<string>}
     */
    exec(cmd) {
        return new Promise((resolve, reject) => {
            /** @type {PowerShellCmd} */
            const q = {
                cmd: cmd.trim() + '\n',
                resolve: resolve,
                reject: reject,
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
     * @returns {void}
     */
    deinit() {
        this.#child?.kill();
    }
}
