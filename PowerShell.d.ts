export type PowerShellOptions = {
    shell?: string;
    args?: string[];
};

export class PowerShell {
    /**
     * Spawns a PowerShell process.
     * You can only have one of these.
     * Call deinit() once finished to kill the PowerShell process.
     */
    init(options?: PowerShellOptions): Promise<void>;

    /**
     * Executes the command.
     * Any Exception or ExceptionRecord will emit the Message on the Exception to stderr.
     * Any output on stderr will be rejected.
     * Otherwise any output on stdout will be resolved as a string.
     * You could pipe your output the PowerShell applet ConvertTo-Json at the end of your
     * command and then use JSON.parse() on the string you can back, or do your own thing.
     */
    exec(cmd: string): Promise<string>;

    /**
     * Kill any child process.
     */
    deinit(): void;
}
