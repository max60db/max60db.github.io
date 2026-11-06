(function () {
    "use strict";

    const { SynthUSB3Client, formatFrequency, formatPower, formatPllEnabled } = window.SynthUSB3;
    const $ = (id) => document.getElementById(id);
    let client = null;
    let connecting = false;

    function setNotice(message, isError = false) {
        const notice = $("notice");
        notice.textContent = message;
        notice.setAttribute("aria-live", isError ? "assertive" : "polite");
    }

    function setConnected(connected, detail = "") {
        $("connection-state").textContent = connected ? "SynthUSB3 connected" : "Not connected";
        $("connection-detail").textContent = detail || (connected ? "USB serial link ready" : "Web Serial requires Chrome or Edge on HTTPS or localhost.");
        $("connect-button").disabled = connecting;
        $("disconnect-button").disabled = !connected || connecting;
        $("refresh-button").disabled = !connected;
        $("eeprom-button").disabled = !connected;
        document.querySelectorAll(".send-button").forEach((button) => { button.disabled = !connected; });
    }

    function renderStatuses(statuses) {
        const body = $("status-body");
        body.replaceChildren();
        for (const status of statuses) {
            const row = document.createElement("tr");
            const name = document.createElement("td");
            const value = document.createElement("td");
            name.textContent = status.label;
            value.textContent = status.value === null ? "Not returned" : status.value;
            row.append(name, value);
            body.append(row);
        }
        $("status-updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
    }

    async function runCommand(packet, successMessage) {
        if (!client) return;
        try {
            await client.send(packet);
            setNotice(successMessage);
        } catch (error) {
            setNotice(error.message, true);
        }
    }

    $("connect-button").addEventListener("click", async () => {
        if (!("serial" in navigator)) {
            setNotice("Web Serial is not available in this browser. Use Chrome or Edge over HTTPS or localhost.", true);
            return;
        }
        connecting = true;
        $("connect-button").disabled = true;
        $("disconnect-button").disabled = true;
        try {
            if (client) {
                await client.disconnect();
                client = null;
                setConnected(false);
            }
            setNotice("Select the SynthUSB3 device to connect.");
            const port = await navigator.serial.requestPort();
            client = new SynthUSB3Client(port);
            await client.connect();
            const info = port.getInfo ? port.getInfo() : {};
            const detail = info.usbVendorId
                ? `USB ${info.usbVendorId.toString(16).padStart(4, "0")}:${(info.usbProductId || 0).toString(16).padStart(4, "0")}`
                : "USB serial link ready";
            setConnected(true, detail);
            setNotice("Connected. Refresh status to read current settings.");
        } catch (error) {
            client = null;
            setConnected(false);
            setNotice(error.message || "Could not connect to the serial device.", true);
        } finally {
            connecting = false;
            $("connect-button").disabled = false;
            $("disconnect-button").disabled = !client;
        }
    });

    $("disconnect-button").addEventListener("click", async () => {
        try {
            if (client) await client.disconnect();
            client = null;
            setConnected(false);
            setNotice("Device disconnected.");
        } catch (error) {
            setNotice(error.message, true);
        }
    });

    $("refresh-button").addEventListener("click", async () => {
        if (!client) return;
        $("refresh-button").disabled = true;
        setNotice("Reading device settings...");
        try {
            renderStatuses(await client.refreshStatuses());
            setNotice("Status read completed.");
        } catch (error) {
            setNotice(error.message, true);
        } finally {
            $("refresh-button").disabled = !client;
        }
    });

    $("frequency-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const field = $("frequency");
        if (!field.reportValidity()) return;
        try { runCommand(formatFrequency(field.value), "Frequency command sent."); }
        catch (error) { setNotice(error.message, true); }
    });

    $("power-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const field = $("power");
        if (!field.reportValidity()) return;
        try { runCommand(formatPower(field.value), "Power command sent."); }
        catch (error) { setNotice(error.message, true); }
    });

    $("pll-form").addEventListener("submit", (event) => {
        event.preventDefault();
        try { runCommand(formatPllEnabled($("pll").value), "PLL power command sent."); }
        catch (error) { setNotice(error.message, true); }
    });

    $("eeprom-button").addEventListener("click", () => {
        if (window.confirm("Write the current SynthUSB3 settings to nonvolatile memory? This changes the device's power-up state.")) {
            runCommand("e", "EEPROM write command sent.");
        }
    });
})();