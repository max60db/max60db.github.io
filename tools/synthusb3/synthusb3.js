(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.SynthUSB3 = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
    "use strict";

    const STATUS_FIELDS = [
        ["f", "RF Frequency Now (MHz)"],
        ["W", "RF Power (dBm)"],
        ["V", "Amp Calibration success?"],
        ["a", "VGA DAC Setting (0=min, 63=max)"],
        ["E", "PLL Chip Enable (1=on, 0=off)"],
        ["U", "PLL charge pump current"],
        ["D", "REF Doubler (1=on, 0=off)"],
        ["i", "Channel spacing (Hz)"],
        ["x", "Reference (external=0, internal 27MHz=1)"],
        ["*", "PLL reference frequency (MHz)"],
        ["l", "Sweep lower frequency (MHz)"],
        ["u", "Sweep upper frequency (MHz)"],
        ["s", "Sweep step size (MHz/%)"],
        ["t", "Sweep step time (mS)"],
        ["[", "Sweep amplitude low (dBm)"],
        ["]", "Sweep amplitude high (dBm)"],
        ["^", "Sweep direction (up=1 / down=0)"],
        ["X", "Sweep type (lin=0 / tab=1 / %=2)"],
        ["d", "Sweep display (off=0 / freq=1 / freq + amp=2)"],
        ["g", "Sweep run (on=1 / off=0)"],
        ["c", "Sweep continuous mode"],
        ["y", "Trigger function"],
        ["Y", "Trigger polarity (active low=0 / active high=1)"],
        ["F", "AM step time (uS)"],
        ["q", "AM number of cycle repetitions"],
        ["A", "AM run continuous (on=1 / off=0)"],
        ["P", "Pulse on time (uS)"],
        ["O", "Pulse off time (uS)"],
        ["R", "Pulse number of repetitions"],
        ["j", "Pulse continuous mode"],
        ["<", "FM frequency (Hz)"],
        [">", "FM deviation (Hz)"],
        [",", "FM number of repetitions"],
        [";", "FM type (sinusoid=0 / chirp=1)"],
        ["/", "FM continuous mode"],
        ["p", "Phase lock status (lock=1 / unlock=0)"],
        ["m", "Communication mode (UART=1 / USB=0)"],
        ["v", "Firmware version"],
        ["+", "Model type"],
        ["-", "Serial number"]
    ].map(([command, label]) => ({ command, label }));

    function parseStatusLines(lines) {
        const values = new Map();
        const additionalFields = new Map();
        const knownCommands = new Set(STATUS_FIELDS.map((field) => field.command));
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line === "EOM." || line === "EOM") continue;
            const command = line[0];
            const value = line.slice(1).trim();
            if (knownCommands.has(command)) {
                values.set(command, value);
            } else if (value && !/\s/.test(value)) {
                additionalFields.set(command, value);
            }
        }
        const statuses = STATUS_FIELDS.map((field) => ({
            ...field,
            value: values.has(field.command) ? values.get(field.command) : null
        }));
        for (const [command, value] of additionalFields) {
            statuses.push({ command, label: "Firmware-specific field", value });
        }
        return statuses;
    }

    function formatNumericCommand(command, value, { min, max, decimals }) {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue) || numericValue < min || numericValue > max) {
            throw new RangeError(`Value must be between ${min} and ${max}.`);
        }
        return `${command}${numericValue.toFixed(decimals)}`;
    }

    function formatFrequency(value) {
        return formatNumericCommand("f", value, { min: 12.5, max: 6400, decimals: 7 });
    }

    function formatPower(value) {
        return formatNumericCommand("W", value, { min: -50, max: 10, decimals: 2 });
    }

    function formatPllEnabled(value) {
        if (value !== "0" && value !== "1") throw new RangeError("PLL state must be 0 or 1.");
        return `E${value}`;
    }

    class SynthUSB3Client {
        constructor(port, responseTimeoutMs = 5000) {
            this.port = port;
            this.responseTimeoutMs = responseTimeoutMs;
            this.reader = null;
            this.writer = null;
            this.readTask = null;
            this.lineQueue = [];
            this.lineWaiters = [];
            this.operation = Promise.resolve();
            this.decoder = new TextDecoder();
            this.connected = false;
        }

        async connect() {
            if (this.connected) return;
            await this.port.open({ baudRate: 115200 });
            this.reader = this.port.readable.getReader();
            this.writer = this.port.writable.getWriter();
            this.connected = true;
            this.readTask = this.readLoop();
        }

        async disconnect() {
            if (!this.connected) return;
            this.connected = false;
            try { await this.reader.cancel(); } catch (_) { /* Port may already be closed. */ }
            try { await this.writer.close(); } catch (_) { /* Port may already be closed. */ }
            this.reader.releaseLock();
            this.writer.releaseLock();
            this.reader = null;
            this.writer = null;
            await this.port.close();
            this.rejectWaiters(new Error("Serial connection closed."));
        }

        async readLoop() {
            let pending = "";
            try {
                while (this.connected) {
                    const { value, done } = await this.reader.read();
                    if (done) break;
                    pending += this.decoder.decode(value, { stream: true });
                    const lines = pending.split("\n");
                    pending = lines.pop();
                    for (const line of lines) this.pushLine(line.replace(/\r$/, ""));
                }
            } catch (error) {
                if (this.connected) this.rejectWaiters(error);
            }
        }

        pushLine(line) {
            const waiter = this.lineWaiters.shift();
            if (waiter) {
                clearTimeout(waiter.timer);
                waiter.resolve(line);
            } else {
                this.lineQueue.push(line);
            }
        }

        rejectWaiters(error) {
            for (const waiter of this.lineWaiters.splice(0)) {
                clearTimeout(waiter.timer);
                waiter.reject(error);
            }
        }

        nextLine() {
            if (this.lineQueue.length) return Promise.resolve(this.lineQueue.shift());
            return new Promise((resolve, reject) => {
                const waiter = { resolve, reject, timer: null };
                waiter.timer = setTimeout(() => {
                    this.lineWaiters = this.lineWaiters.filter((item) => item !== waiter);
                    reject(new Error("Timed out waiting for a SynthUSB3 response."));
                }, this.responseTimeoutMs);
                this.lineWaiters.push(waiter);
            });
        }

        enqueue(operation) {
            const current = this.operation.then(operation, operation);
            this.operation = current.catch(() => {});
            return current;
        }

        writePacket(packet) {
            if (!this.connected || !this.writer) throw new Error("Connect to a SynthUSB3 first.");
            if (/[\r\n]/.test(packet)) throw new Error("SynthUSB3 commands must not contain line endings.");
            return this.writer.write(new TextEncoder().encode(packet));
        }

        send(packet) {
            return this.enqueue(() => this.writePacket(packet));
        }

        request(packet) {
            return this.enqueue(async () => {
                await this.writePacket(packet);
                const lines = [];
                while (true) {
                    const line = await this.nextLine();
                    if (line === "EOM." || line === "EOM") return lines;
                    lines.push(line);
                }
            });
        }

        refreshStatuses() {
            return this.request("?1").then(parseStatusLines);
        }
    }

    return {
        STATUS_FIELDS,
        SynthUSB3Client,
        formatFrequency,
        formatPower,
        formatPllEnabled,
        parseStatusLines
    };
});