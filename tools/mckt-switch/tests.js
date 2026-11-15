(function () {
    "use strict";

    const results = document.getElementById("results");
    const api = window.MiniCircuitsSwitch;
    const usbApi = window.MiniCircuitsSwitchUSB;
    let passed = 0;
    let failed = 0;

    function assert(condition, message) {
        if (!condition) throw new Error(message);
    }

    function test(name, action) {
        const row = document.createElement("li");
        try {
            action();
            row.textContent = `PASS ${name}`;
            passed += 1;
        } catch (error) {
            row.textContent = `FAIL ${name}: ${error.message}`;
            failed += 1;
        }
        results.append(row);
    }

    async function testAsync(name, action) {
        const row = document.createElement("li");
        try {
            await action();
            row.textContent = `PASS ${name}`;
            passed += 1;
        } catch (error) {
            row.textContent = `FAIL ${name}: ${error.message}`;
            failed += 1;
        }
        results.append(row);
    }

    test("parses numeric switch responses", () => {
        assert(api.parseSingleState("1") === 1, "plain response failed");
        assert(api.parseSingleState("1=683 2=641 3=120") === 120, "counter response failed");
        assert(api.parseSingleState("-99 unknown command") === null, "error response accepted");
    });

    test("names switches alphabetically", () => {
        assert(api.switchName(0) === "A", "first switch name incorrect");
        assert(api.switchName(7) === "H", "eighth switch name incorrect");
    });

    test("selects the protocol family from ports per switch", () => {
        document.getElementById("port-count").value = "2";
        assert(api.modelType() === "SPDT", "SPDT selection failed");
        document.getElementById("port-count").value = "4";
        assert(api.modelType() === "SP4T", "SP4T selection failed");
        document.getElementById("port-count").value = "6";
        assert(api.modelType() === "SP6T", "SP6T selection failed");
        document.getElementById("port-count").value = "8";
        assert(api.modelType() === "SP8T", "SP8T selection failed");
    });

    test("identifies USB, RC, and ZTRC model configurations", () => {
        const usbSpdt = api.configurationFromModel("USB-4SPDT-A18");
        assert(usbSpdt.switchCount === 4 && usbSpdt.portCount === 2, "USB SPDT configuration was not detected");
        const usbSp4t = api.configurationFromModel("USB-2SP4T-A18");
        assert(usbSp4t.switchCount === 2 && usbSp4t.portCount === 4, "USB SP4T configuration was not detected");
        const ethernet = api.configurationFromModel("RC-1SP4T-A18");
        assert(ethernet.switchCount === 1 && ethernet.portCount === 4, "RC configuration was not detected");
        const rack = api.configurationFromModel("ZTRC-4SPDT-A18");
        assert(rack.switchCount === 4 && rack.portCount === 2, "ZTRC configuration was not detected");
        const usbSp8t = api.configurationFromModel("USB-1SP8T-A18");
        assert(usbSp8t.switchCount === 1 && usbSp8t.portCount === 8, "SP8T configuration was not detected");
    });

    test("parses Ethernet and bare USB model responses", () => {
        assert(api.modelNameFromResponse("MN=RC-1SP4T-A18") === "RC-1SP4T-A18", "Ethernet model response failed");
        assert(api.modelNameFromResponse("USB-4SPDT-A18") === "USB-4SPDT-A18", "USB model response failed");
        const usbModel = api.modelNameFromResponse("USB-4SPDT-A18");
        const configuration = api.configurationFromModel(usbModel);
        assert(configuration.switchCount === 4 && configuration.portCount === 2, "USB Auto identify configuration failed");
        const sp8tModel = api.modelNameFromResponse("MN=RC-1SP8T-A18");
        assert(api.configurationFromModel(sp8tModel).portCount === 8, "SP8T Auto identify configuration failed");
    });

    class FakeHidDevice {
        constructor() {
            this.collections = [{
                inputReports: [{ reportId: 0 }],
                outputReports: [{ reportId: 0 }]
            }];
            this.listeners = new Map();
            this.reports = [];
        }

        async open() {}
        async close() {}

        addEventListener(name, callback) {
            this.listeners.set(name, callback);
        }

        removeEventListener(name) {
            this.listeners.delete(name);
        }

        async sendReport(reportId, request) {
            const sent = new Uint8Array(request);
            this.reports.push({ reportId, request: sent });
            const response = new Uint8Array(64);
            response[0] = sent[0];
            if (sent[0] === 40) {
                response.set(new TextEncoder().encode("RC-4SPDT-A18"), 1);
            } else if (sent[0] === 15) {
                response[1] = 0x15;
            } else if (sent[0] === 9) {
                response[1] = 2;
            } else if (sent[0] === 42) {
                response.set(new TextEncoder().encode("1"), 1);
            }
            const event = new Event("inputreport");
            Object.defineProperties(event, {
                reportId: { value: 0 },
                data: { value: new DataView(response.buffer) }
            });
            this.listeners.get("inputreport")(event);
        }
    }

    (async () => {
        await testAsync("sends a 64-byte HID model query", async () => {
            const device = new FakeHidDevice();
            const client = new usbApi.MiniCircuitsSwitchUSBClient(device);
            await client.connect();
            assert(await client.send("MN?") === "RC-4SPDT-A18", "model name mismatch");
            assert(device.reports[0].request.length === 64, "HID report was not 64 bytes");
            assert(device.reports[0].request[0] === 40, "model query interrupt was incorrect");
            await client.disconnect();
        });

        await testAsync("sets one SPDT switch through its individual interrupt", async () => {
            const device = new FakeHidDevice();
            const client = new usbApi.MiniCircuitsSwitchUSBClient(device);
            await client.connect();
            assert(await client.send("SETD=1") === "1", "SPDT set was not acknowledged");
            assert(device.reports[0].request[0] === 4, "switch D interrupt was incorrect");
            assert(device.reports[0].request[1] === 1, "SPDT state was incorrect");
            await client.disconnect();
        });

        await testAsync("sets one SP4T switch and preserves the other switch", async () => {
            const device = new FakeHidDevice();
            const client = new usbApi.MiniCircuitsSwitchUSBClient(device);
            await client.connect();
            assert(await client.send("SP4TA:STATE:3") === "1", "SP4T set was not acknowledged");
            assert(device.reports[0].request[0] === 15, "SP4T state was not queried");
            assert(device.reports[1].request[0] === 9, "SP4T set interrupt was incorrect");
            assert(device.reports[1].request[1] === 0x14, "state did not preserve switch B bits");
            await client.disconnect();
        });

        await testAsync("routes other SCPI queries through the USB interrupt", async () => {
            const device = new FakeHidDevice();
            const client = new usbApi.MiniCircuitsSwitchUSBClient(device);
            await client.connect();
            assert(await client.send(":UNKNOWN?") === "1", "SCPI response mismatch");
            assert(device.reports[0].request[0] === 42, "SCPI interrupt was incorrect");
            assert(device.reports[0].request[1] === 58, "SCPI command was not encoded as ASCII");
            await client.disconnect();
        });

        await testAsync("routes SP8T state queries and sets through USB SCPI", async () => {
            const device = new FakeHidDevice();
            const client = new usbApi.MiniCircuitsSwitchUSBClient(device);
            await client.connect();
            assert(await client.send("SP8TA:STATE?") === "1", "SP8T query failed");
            assert(await client.send("SP8TA:STATE:8") === "1", "SP8T port 8 set failed");
            const query = new TextDecoder().decode(device.reports[0].request.subarray(1)).replace(/\0+$/, "");
            const set = new TextDecoder().decode(device.reports[1].request.subarray(1)).replace(/\0+$/, "");
            assert(device.reports[0].request[0] === 42 && query === ":SP8TA:STATE?", "SP8T query was not sent as SCPI");
            assert(device.reports[1].request[0] === 42 && set === ":SP8TA:STATE:8", "SP8T set was not sent as SCPI");
            await client.disconnect();
        });

        document.getElementById("summary").textContent = `${passed} passed, ${failed} failed`;
    })();
})();
