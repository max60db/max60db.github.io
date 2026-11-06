(function () {
    "use strict";

    const $ = (id) => document.getElementById(id);
    let requestChain = Promise.resolve();
    let autoRefreshToken = null;

    function setText(id, value) {
        const element = $(id);
        if (element) element.textContent = value;
    }

    function notice(message, kind) {
        const element = $("notice");
        if (!element) return;
        element.textContent = message;
        element.className = kind || "";
    }

    function baseUrl() {
        const address = $("address").value.trim();
        const port = Number($("port").value);
        if (!/^[a-z0-9.-]+$/i.test(address)) throw new Error("Enter a hostname or IPv4 address.");
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("HTTP port must be 1-65535.");
        return `http://${address}:${port}`;
    }

    function queued(operation) {
        const result = requestChain.then(operation, operation);
        requestChain = result.catch(() => {});
        return result;
    }

    async function send(command) {
        if (!/^[\x20-\x7e]{1,63}$/.test(command)) throw new Error("Command must be 1-63 printable ASCII characters.");
        return queued(async () => {
            const time = () => new Date().toLocaleTimeString();
            setText("last-command", `${command} (${time()})`);
            // Keep a query marker after the slash. Encoding it changes the device command.
            const url = command.startsWith(":")
                ? `${baseUrl()}/${encodeURI(command)}`
                : command.endsWith("?")
                    ? `${baseUrl()}/?${encodeURI(command)}`
                    : `${baseUrl()}/${encodeURI(command)}`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            try {
                const response = await fetch(url, { cache: "no-store", signal: controller.signal });
                const text = (await response.text()).trim();
                setText("last-response", `${text || "empty response"} (${time()})`);
                if (!response.ok) {
                    const error = new Error(`HTTP ${response.status}: ${text || "empty response"}`);
                    error.connectionFailure = true;
                    throw error;
                }
                if (/^-\d+\s+(?:unknown|invalid|error)/i.test(text)) {
                    throw new Error(`Device rejected ${command}: ${text}`);
                }
                return text;
            } catch (error) {
                if (error.name === "AbortError") {
                    error.connectionFailure = true;
                    error.message = "HTTP request timed out after 5 seconds.";
                } else if (error.name === "TypeError") error.connectionFailure = true;
                setText("last-response", `${error.message} (${time()})`);
                throw error;
            } finally {
                clearTimeout(timeout);
            }
        });
    }

    function markFailure(error) {
        if (error.connectionFailure) setText("connection-state", "Failed");
        notice(error.message, "error");
    }

    async function readMeasurement(command, target) {
        try {
            const value = await send(command);
            setText(target, value);
            setText("connection-state", "Connected");
            return value;
        } catch (error) {
            setText(target, error.message);
            markFailure(error);
            throw error;
        }
    }

    async function refreshStatus() {
        const rows = [
            ["Sensor model", ":MN?"],
            ["Sensor serial number", ":SN?"],
            ["Firmware", ":FIRMWARE?"],
            ["Temperature format", ":TEMP:FORMAT?"],
            ["Temperature", ":TEMP?"],
            ["Compensation frequency", ":FREQ?"],
            ["Measurement mode", ":MODE?"],
            ["Sample time", ":SAMPLETIME?"],
            ["Power", ":POWER?"],
            ["Voltage", ":VOLTAGE?"],
            ["Averaging enabled", ":AVG:STATE?"],
            ["Average count", ":AVG:COUNT?"],
            ["Buffered mode", ":BUFFEREDMODE?"],
            ["Buffer size", ":BUFFERMODE:SIZE?"],
            ["Trigger mode", ":TRIGGER:MODE?"],
            ["External trigger on-fall", ":TRIGGER:EXTERNAL:ONFALL?"],
            ["External trigger on-rise", ":TRIGGER:EXTERNAL:ONRISE?"],
            ["Internal trigger on-fall", ":TRIGGER:INTERNAL:ONFALL?"],
            ["Internal trigger on-rise", ":TRIGGER:INTERNAL:ONRISE?"],
            ["Trigger delay", ":TRIGGER:DELAY?"],
            ["Trigger timeout", ":TRIGGER:TIMEOUT?"],
            ["Trigger level", ":TRIGGER:LEVEL?"],
            ["Trigger pulse-width mode", ":TRIGGER:PULSEWIDTH:MODE?"],
            ["Trigger pulse-width minimum", ":TRIGGER:PULSEWIDTH:MIN:VAL?"],
            ["Trigger pulse-width maximum", ":TRIGGER:PULSEWIDTH:MAX:VAL?"],
            ["External output", ":EXTOUT:SELECT?"],
            ["Trigger output mode", ":TRIGGEROUT:MODE?"],
            ["Density factor", ":DENSITY:FACTOR?"],
            ["Number of points", ":NPOINTS?"],
            ["Sample rate", ":SAMPLERATE?"],
            ["Bandwidth filter", ":BWFILTER?"],
            ["Peak and average power", ":POWER?"],
            ["Power array", ":POWER_ARRAY?"],
            ["Real-time peak power", ":RTPEAK?"],
            ["Zeroing complete", ":APP:ZERO:DONE?"],
            ["Display screen", ":DISPLAY:SCREEN?"],
            ["Display rotation", ":DISPLAY:ROTATE?"],
            ["Ethernet configuration", ":ETHERNET:CONFIG:LISTEN?"],
            ["MAC address", ":ETHERNET:CONFIG:MAC?"],
            ["DHCP enabled", ":ETHERNET:CONFIG:DHCPENABLED?"],
            ["IP address", ":ETHERNET:CONFIG:IP?"],
            ["Network gateway", ":ETHERNET:CONFIG:NG?"],
            ["Subnet mask", ":ETHERNET:CONFIG:SM?"],
            ["HTTP port", ":ETHERNET:CONFIG:HTPORT?"],
            ["Telnet port", ":ETHERNET:CONFIG:TELNETPORT?"],
            ["SSH port", ":ETHERNET:CONFIG:SSHPORT?"],
            ["SSH login name", ":ETHERNET:CONFIG:SSHLOGINNAME?"],
            ["Password enabled", ":ETHERNET:CONFIG:PWDENABLED?"],
            ["Ethernet enabled", ":ETHERNET:CONFIG:ETHERNETENABLED?"]
        ];
        const values = [];
        for (const [label, command] of rows) {
            try {
                values.push([label, await send(command)]);
            } catch (error) {
                values.push([label, error.message]);
            }
        }
        $("status-body").replaceChildren(...values.map(([label, value]) => {
            const row = document.createElement("tr");
            const name = document.createElement("td");
            const result = document.createElement("td");
            name.textContent = label;
            result.textContent = value;
            row.append(name, result);
            return row;
        }));
        setText("status-updated", `Updated ${new Date().toLocaleTimeString()}`);
        const model = values.find(([label]) => label === "Sensor model");
        if (model && !model[1].startsWith("HTTP") && !model[1].includes("timed out")) {
            setText("connection-state", model[1].replace(/^Model:\s*/i, "").trim());
        }
    }

    $("test-button").addEventListener("click", async () => {
        const button = $("test-button");
        button.disabled = true;
        try {
            const response = await send("MN?");
            setText("connection-state", response.replace(/^Model:\s*/i, "").trim());
            notice("", "");
        } catch (error) {
            markFailure(error);
        } finally {
            button.disabled = false;
        }
    });

    $("power-button").addEventListener("click", async () => {
        const button = $("power-button");
        button.disabled = true;
        try { await readMeasurement("MEAS:POWER?", "power-value"); } catch (_) {}
        finally { button.disabled = false; }
    });

    $("refresh-button").addEventListener("click", async () => {
        const button = $("refresh-button");
        button.disabled = true;
        try { await refreshStatus(); notice("", ""); }
        catch (error) { markFailure(error); }
        finally { button.disabled = false; }
    });

    async function autoRefresh() {
        if (autoRefreshToken) return;
        const token = {};
        autoRefreshToken = token;
        const poll = async () => {
            if (autoRefreshToken !== token) return;
            try { await readMeasurement("MEAS:POWER?", "power-value"); }
            catch (_) {}
            if (autoRefreshToken === token) setTimeout(poll, 500);
        };
        await poll();
    }

    function disableAutoRefresh() {
        autoRefreshToken = null;
        setAutoRefreshControls(false);
    }

    function setAutoRefreshControls(enabled) {
        $("auto-refresh-button").disabled = enabled;
        $("disable-auto-refresh-button").disabled = false;
    }
    setAutoRefreshControls(false);

    $("auto-refresh-button").addEventListener("click", () => {
        autoRefresh();
        setAutoRefreshControls(true);
        notice("Automatic power refresh enabled.", "success");
    });
    $("disable-auto-refresh-button").addEventListener("click", () => {
        disableAutoRefresh();
        notice("Automatic power refresh disabled.", "success");
    });

    $("set-compensation-frequency-button").addEventListener("click", async () => {
        const input = $("compensation-frequency");
        const button = $("set-compensation-frequency-button");
        const frequency = Number(input.value);
        if (!Number.isFinite(frequency) || frequency < 0) {
            notice("Enter a non-negative compensation frequency in MHz.", "error");
            return;
        }
        button.disabled = true;
        try {
            const response = await send(`:FREQ:${frequency}`);
            if (response !== "1") throw new Error(`Device returned ${response || "an empty response"}.`);
            notice("Compensation frequency updated.", "success");
        } catch (error) {
            markFailure(error);
        } finally {
            button.disabled = false;
        }
    });

    window.MiniCircuitsPower = {
        parseResponse: (value) => String(value).trim(),
        autoRefresh,
        disableAutoRefresh,
        setAutoRefreshControls
    };
})();
