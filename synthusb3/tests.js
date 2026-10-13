(async function () {
    "use strict";

    const { SynthUSB3Client, STATUS_FIELDS, formatFrequency, formatPower, formatPllEnabled, parseStatusLines } = window.SynthUSB3;
    const results = document.getElementById("results");
    let passed = 0;
    let failed = 0;

    function assert(condition, message) {
        if (!condition) throw new Error(message);
    }

    async function test(name, action) {
        const row = document.createElement("li");
        try {
            await action();
            row.className = "pass";
            row.textContent = `PASS ${name}`;
            passed += 1;
        } catch (error) {
            row.className = "fail";
            row.textContent = `FAIL ${name}: ${error.message}`;
            failed += 1;
        }
        results.append(row);
    }

    class FakePort {
        constructor(onWrite) {
            this.writes = [];
            this.onWrite = onWrite;
            this.readController = null;
            this.opened = false;
            this.readable = new ReadableStream({ start: (controller) => { this.readController = controller; } });
            this.writable = new WritableStream({
                write: (bytes) => {
                    const packet = new TextDecoder().decode(bytes);
                    this.writes.push(packet);
                    if (this.onWrite) this.onWrite(packet, this);
                }
            });
        }

        async open() { this.opened = true; }
        async close() { this.opened = false; }
        respond(text) { this.readController.enqueue(new TextEncoder().encode(text)); }
    }

    await test("format frequency, power, and PLL command packets", () => {
        assert(formatFrequency("1000.5") === "f1000.5000000", "frequency formatting mismatch");
        assert(formatPower("-3.2") === "W-3.20", "power formatting mismatch");
        assert(formatPllEnabled("1") === "E1", "PLL formatting mismatch");
        assert(STATUS_FIELDS.length === 40, `expected 40 status definitions, got ${STATUS_FIELDS.length}`);
    });

    await test("reject out-of-range values and invalid PLL state", () => {
        let rejected = 0;
        for (const action of [
            () => formatFrequency("12.49"),
            () => formatFrequency("6400.1"),
            () => formatPower("-50.1"),
            () => formatPower("10.1"),
            () => formatPllEnabled("2")
        ]) {
            try { action(); } catch (_) { rejected += 1; }
        }
        assert(rejected === 5, "one or more invalid values were accepted");
    });

    await test("parse query lines including punctuation commands and missing fields", () => {
        const statuses = parseStatusLines(["f1000.00000000\r", "W-3.250", "*27.00000000", "[-10.000", "p1", "B0.0", "r115200", "EOM."]);
        const valueOf = (command) => statuses.find((status) => status.command === command).value;
        assert(valueOf("f") === "1000.00000000", "frequency line not parsed");
        assert(valueOf("*") === "27.00000000", "asterisk command not parsed");
        assert(valueOf("[") === "-10.000", "bracket command not parsed");
        assert(valueOf("p") === "1", "phase lock line not parsed");
        assert(valueOf("E") === null, "missing field should be represented");
        assert(valueOf("B") === "0.0" && valueOf("r") === "115200", "firmware-specific fields were discarded");
    });

    await test("integration: refresh requests ?1 and reads through EOM", async () => {
        const port = new FakePort((packet, fake) => {
            if (packet === "?1") fake.respond("f1000.00000000\nW0.000\np1\nB0.0\nr115200\nEOM.\n");
        });
        const client = new SynthUSB3Client(port, 100);
        await client.connect();
        const statuses = await client.refreshStatuses();
        assert(port.opened, "port did not open");
        assert(port.writes.join("") === "?1", "query packet contains unexpected bytes");
        assert(statuses.find((status) => status.command === "f").value === "1000.00000000", "frequency response missing");
        assert(statuses.find((status) => status.command === "p").value === "1", "lock status missing");
        assert(statuses.find((status) => status.command === "r").value === "115200", "extra device status missing");
        await client.disconnect();
        assert(!port.opened, "port did not close");
    });

    await test("integration: command writes are exact packets without terminators", async () => {
        const port = new FakePort();
        const client = new SynthUSB3Client(port, 100);
        await client.connect();
        await client.send(formatFrequency("2400.25"));
        await client.send(formatPower("-12"));
        await client.send(formatPllEnabled("0"));
        await client.send("e");
        assert(port.writes.join("|") === "f2400.2500000|W-12.00|E0|e", "unexpected command bytes");
        await client.disconnect();
    });

    await test("integration: reject packets that include line endings", async () => {
        const client = new SynthUSB3Client(new FakePort(), 100);
        await client.connect();
        let rejected = false;
        try { await client.send("f1000\n"); } catch (_) { rejected = true; }
        assert(rejected, "line-terminated command should be rejected");
        await client.disconnect();
    });

    document.getElementById("summary").textContent = `${passed} passed, ${failed} failed`;
    document.getElementById("summary").className = failed ? "fail" : "pass";
})();