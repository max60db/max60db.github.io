(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.MiniCircuitsSwitchUSB = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
    "use strict";

    const VENDOR_ID = 0x20ce;
    const PRODUCT_ID = 0x22;
    const REPORT_SIZE = 64;

    function decodeText(report, start = 1, end = report.length) {
        let terminator = end;
        for (let index = start; index < end; index += 1) {
            if (report[index] === 0) {
                terminator = index;
                break;
            }
        }
        return new TextDecoder().decode(report.subarray(start, terminator)).trim();
    }

    function readCounter(report) {
        return report[1] + report[2] * 256 + report[3] * 65536 + report[4] * 16777216;
    }

    class MiniCircuitsSwitchUSBClient {
        constructor(device, responseTimeoutMs = 5000) {
            this.device = device;
            this.responseTimeoutMs = responseTimeoutMs;
            this.inputReportId = null;
            this.outputReportId = null;
            this.connected = false;
            this.operation = Promise.resolve();
            this.pending = null;
            this.onInputReport = (event) => {
                const pending = this.pending;
                if (!pending || event.reportId !== this.inputReportId || event.data.byteLength === 0) return;
                const data = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
                if (data[0] !== pending.responseCode) return;
                this.pending = null;
                clearTimeout(pending.timer);
                pending.resolve(new Uint8Array(data));
            };
        }

        async connect() {
            if (this.connected) return;
            await this.device.open();
            const collection = this.device.collections.find((item) => item.inputReports.length && item.outputReports.length);
            if (!collection) {
                await this.device.close();
                throw new Error("The selected USB device has no HID input and output reports.");
            }
            this.inputReportId = collection.inputReports[0].reportId;
            this.outputReportId = collection.outputReports[0].reportId;
            this.device.addEventListener("inputreport", this.onInputReport);
            this.connected = true;
        }

        async disconnect() {
            if (!this.connected) return;
            this.connected = false;
            this.device.removeEventListener("inputreport", this.onInputReport);
            if (this.pending) {
                const pending = this.pending;
                this.pending = null;
                clearTimeout(pending.timer);
                pending.reject(new Error("USB connection closed."));
            }
            await this.device.close();
        }

        enqueue(operation) {
            const current = this.operation.then(operation, operation);
            this.operation = current.catch(() => {});
            return current;
        }

        transact(commandCode, payload = [], responseCode = commandCode) {
            if (!this.connected) throw new Error("Connect to a Mini-Circuits switch over USB first.");
            if (payload.length > REPORT_SIZE - 1) throw new Error("USB command exceeds the 64-byte HID report size.");
            const request = new Uint8Array(REPORT_SIZE);
            request[0] = commandCode;
            request.set(payload, 1);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    if (this.pending?.timer !== timer) return;
                    this.pending = null;
                    const error = new Error("Timed out waiting for a Mini-Circuits USB response.");
                    error.connectionFailure = true;
                    reject(error);
                }, this.responseTimeoutMs);
                this.pending = { responseCode, timer, resolve, reject };
                this.device.sendReport(this.outputReportId, request).catch((error) => {
                    if (this.pending?.timer !== timer) return;
                    this.pending = null;
                    clearTimeout(timer);
                    error.connectionFailure = true;
                    reject(error);
                });
            });
        }

        send(command) {
            if (!/^[\x20-\x7e]{1,63}$/.test(command)) {
                throw new Error("Command must be 1-63 printable ASCII characters.");
            }
            return this.enqueue(() => this.sendCommand(command));
        }

        async sendCommand(command) {
            let match = command.match(/^(MN|SN|FIRMWARE)\?$/i);
            if (match) {
                const code = { MN: 40, SN: 41, FIRMWARE: 99 }[match[1].toUpperCase()];
                const report = await this.transact(code);
                return code === 99 ? String.fromCharCode(report[5], report[6]) : decodeText(report);
            }

            match = command.match(/^TEMP([123])\?$/i);
            if (match) {
                const code = { 1: 114, 2: 115, 3: 118 }[match[1]];
                return decodeText(await this.transact(code), 1, 7);
            }

            match = command.match(/^(HEATALARM|FAN)\?$/i);
            if (match) {
                const code = match[1].toUpperCase() === "HEATALARM" ? 117 : 119;
                return String((await this.transact(code))[1]);
            }

            if (/^SWPORT\?$/i.test(command)) {
                const report = await this.transact(15);
                return `SWPORT?=${report[1]}`;
            }

            match = command.match(/^SET([A-H])=([01])$/i);
            if (match) {
                const switchCode = match[1].toUpperCase().charCodeAt(0) - 64;
                await this.transact(switchCode, [Number(match[2])]);
                return "1";
            }

            match = command.match(/^SC([A-H])\?$/i);
            if (match) {
                const code = match[1].toUpperCase().charCodeAt(0);
                return String(readCounter(await this.transact(17, [code])));
            }

            match = command.match(/^SP4T([A-H]):STATE\?$/i);
            if (match) {
                const switchIndex = match[1].toUpperCase().charCodeAt(0) - 65;
                if (switchIndex > 1) throw new Error("The USB SP4T protocol supports switches A and B only.");
                const shift = switchIndex * 4;
                const mask = ((await this.transact(15))[1] >> shift) & 0x0f;
                if (mask && (mask & (mask - 1))) throw new Error(`USB returned an invalid state mask for switch ${match[1]}.`);
                const state = mask === 0 ? 0 : 32 - Math.clz32(mask);
                return `${command}=${state}`;
            }

            match = command.match(/^SP4T([A-H]):STATE:([0-4])$/i);
            if (match) {
                const switchIndex = match[1].toUpperCase().charCodeAt(0) - 65;
                if (switchIndex > 1) throw new Error("The USB SP4T protocol supports switches A and B only.");
                const shift = switchIndex * 4;
                const current = (await this.transact(15))[1];
                const otherSwitches = current & ~(0x0f << shift);
                const targetMask = match[2] === "0" ? 0 : 1 << (Number(match[2]) - 1);
                const response = await this.transact(9, [otherSwitches | (targetMask << shift)]);
                if (response[1] !== 2) throw new Error(`USB switch command failed with status ${response[1]}.`);
                return "1";
            }

            match = command.match(/^SP6T([A-H]):STATE\?$/i);
            if (match) {
                const switchIndex = match[1].toUpperCase().charCodeAt(0) - 64;
                if (switchIndex > 2) throw new Error("The USB SP6T protocol supports switches A and B only.");
                const report = await this.transact(13, [switchIndex]);
                return `${command}=${report[1]}`;
            }

            match = command.match(/^SP6T([A-H]):STATE:([0-6])$/i);
            if (match) {
                const switchIndex = match[1].toUpperCase().charCodeAt(0) - 64;
                if (switchIndex > 2) throw new Error("The USB SP6T protocol supports switches A and B only.");
                await this.transact(12, [switchIndex, Number(match[2])]);
                return "1";
            }

            const scpiCommand = command.startsWith(":") ? command : `:${command}`;
            if (scpiCommand.length > REPORT_SIZE - 1) {
                throw new Error("SCPI command exceeds the 64-byte USB HID report size.");
            }
            const payload = Array.from(scpiCommand, (character) => character.charCodeAt(0));
            const response = decodeText(await this.transact(42, payload));
            if (response.startsWith("-")) throw new Error(`Device rejected ${command}: ${response}`);
            return response;
        }
    }

    return { MiniCircuitsSwitchUSBClient, PRODUCT_ID, VENDOR_ID };
});
