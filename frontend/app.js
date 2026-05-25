const API_BASE = localStorage.getItem("apiBase") || "http://localhost:5000";

const state = {
    token: localStorage.getItem("token"),
    username: localStorage.getItem("username"),
    isAdmin: localStorage.getItem("isAdmin") === "true",
    devices: [],
    users: [],
    selectedDeviceId: Number(localStorage.getItem("selectedDeviceId")) || null,
    selectedChartFieldKey: localStorage.getItem("selectedChartFieldKey") || null,
    selectedPeriod: localStorage.getItem("selectedPeriod") || "24h",
    measurements: [],
    newDeviceFields: [],
    chartView: null,
    hoverPoint: null,
    isDraggingChart: false,
    dragStart: null
};

const loginView = document.getElementById("loginView");
const dashboardView = document.getElementById("dashboardView");
const currentUser = document.getElementById("currentUser");
const logoutButton = document.getElementById("logoutButton");
const deleteDeviceButton = document.getElementById("deleteDeviceButton");

const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");
const loginMessage = document.getElementById("loginMessage");

const deviceForm = document.getElementById("deviceForm");
const dashboardMessage = document.getElementById("dashboardMessage");

const deviceCount = document.getElementById("deviceCount");
const fieldCount = document.getElementById("fieldCount");
const measurementCount = document.getElementById("measurementCount");
const selectedDeviceShort = document.getElementById("selectedDeviceShort");

const deviceList = document.getElementById("deviceList");
const newDeviceFields = document.getElementById("newDeviceFields");
const newFieldLabel = document.getElementById("newFieldLabel");
const newFieldUnit = document.getElementById("newFieldUnit");
const addFieldButton = document.getElementById("addFieldButton");

const measurementForm = document.getElementById("measurementForm");
const measurementFields = document.getElementById("measurementFields");
const measurementHint = document.getElementById("measurementHint");
const measurementTimestamp = document.getElementById("measurementTimestamp");

const selectedDeviceTitle = document.getElementById("selectedDeviceTitle");
const chartFieldSelect = document.getElementById("chartFieldSelect");
const chartPeriodSelect = document.getElementById("chartPeriodSelect");
const resetChartButton = document.getElementById("resetChartButton");

const measurementTable = document.getElementById("measurementTable");
const chartCanvas = document.getElementById("chartCanvas");
const chartWrapper = document.getElementById("chartWrapper");
const chartTooltip = document.getElementById("chartTooltip");
const adminPanel = document.getElementById("adminPanel");
const userTable = document.getElementById("userTable");


async function apiRequest(path, options = {}) {
    const headers = {
        "Content-Type": "application/json",
        ...(options.headers || {})
    };

    if (state.token) {
        headers.Authorization = `Bearer ${state.token}`;
    }

    const response = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.error || "Request failed");
    }

    return data;
}


function getSelectedDevice() {
    return state.devices.find(device => device.id === state.selectedDeviceId) || null;
}


function renderCurrentUser() {
    if (!state.username) {
        currentUser.textContent = "Not logged in";
        return;
    }

    currentUser.textContent = state.isAdmin
        ? `Logged in as ${state.username} (admin)`
        : `Logged in as ${state.username}`;
}


function persistSession() {
    if (state.token) {
        localStorage.setItem("token", state.token);
    }

    if (state.username) {
        localStorage.setItem("username", state.username);
    }

    localStorage.setItem("isAdmin", String(state.isAdmin));
}


function clearSession() {
    state.token = null;
    state.username = null;
    state.isAdmin = false;
    state.users = [];

    localStorage.removeItem("token");
    localStorage.removeItem("username");
    localStorage.removeItem("isAdmin");
}


function showLogin() {
    loginView.classList.remove("hidden");
    dashboardView.classList.add("hidden");
    logoutButton.classList.add("hidden");
    renderCurrentUser();
    renderAdminUsers();
}


function showDashboard() {
    loginView.classList.add("hidden");
    dashboardView.classList.remove("hidden");
    logoutButton.classList.remove("hidden");
    renderCurrentUser();
    renderAdminUsers();
}


function setLoginMessage(text, isError = false) {
    loginMessage.textContent = text;
    loginMessage.className = isError ? "message error" : "message";
}


function setDashboardMessage(text, isError = false) {
    dashboardMessage.textContent = text;
    dashboardMessage.className = isError ? "message error" : "message";
}


async function loadDashboard() {
    const data = await apiRequest("/api/dashboard");

    state.username = data.username;
    state.isAdmin = Boolean(data.is_admin);
    persistSession();
    renderCurrentUser();

    deviceCount.textContent = data.device_count;
    fieldCount.textContent = data.field_count;
    measurementCount.textContent = data.measurement_count;
}


async function loadDevices() {
    state.devices = await apiRequest("/api/devices");

    if (state.devices.length === 0) {
        state.selectedDeviceId = null;
        state.selectedChartFieldKey = null;
    }

    if (state.selectedDeviceId && !state.devices.some(device => device.id === state.selectedDeviceId)) {
        state.selectedDeviceId = null;
        state.selectedChartFieldKey = null;
    }

    if (!state.selectedDeviceId && state.devices.length > 0) {
        state.selectedDeviceId = state.devices[0].id;
    }

    const selectedDevice = getSelectedDevice();

    if (selectedDevice && selectedDevice.fields.length > 0) {
        const hasSelectedField = selectedDevice.fields.some(
            field => field.field_key === state.selectedChartFieldKey
        );

        if (!state.selectedChartFieldKey || !hasSelectedField) {
            state.selectedChartFieldKey = selectedDevice.fields[0].field_key;
        }
    }

    saveSelection();
    renderDevices();
    renderDeviceContext();
}


async function loadUsers() {
    if (!state.isAdmin) {
        state.users = [];
        renderAdminUsers();
        return;
    }

    state.users = await apiRequest("/api/users");
    renderAdminUsers();
}


async function loadMeasurements(resetView = true) {
    const selectedDevice = getSelectedDevice();

    if (!selectedDevice) {
        state.measurements = [];
        renderMeasurements();
        resetChartState();
        drawChart();
        return;
    }

    const params = new URLSearchParams({
        device_id: selectedDevice.id,
        period: state.selectedPeriod,
        limit: "2000"
    });

    const data = await apiRequest(`/api/measurements?${params.toString()}`);

    state.measurements = data.measurements || [];

    renderMeasurements();

    if (resetView) {
        resetChartState();
    }

    drawChart();
}


function saveSelection() {
    if (state.selectedDeviceId) {
        localStorage.setItem("selectedDeviceId", String(state.selectedDeviceId));
    } else {
        localStorage.removeItem("selectedDeviceId");
    }

    if (state.selectedChartFieldKey) {
        localStorage.setItem("selectedChartFieldKey", state.selectedChartFieldKey);
    } else {
        localStorage.removeItem("selectedChartFieldKey");
    }

    localStorage.setItem("selectedPeriod", state.selectedPeriod);
}


function renderDevices() {
    deviceList.innerHTML = "";

    if (state.devices.length === 0) {
        deviceList.innerHTML = `<p class="muted">No devices yet. Create one first.</p>`;
        return;
    }

    for (const device of state.devices) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = device.id === state.selectedDeviceId
            ? "device-item selected"
            : "device-item";

        const fields = device.fields
            .map(field => `${escapeHtml(field.label)}${field.unit ? ` (${escapeHtml(field.unit)})` : ""}`)
            .join(", ");

        item.innerHTML = `
            <strong>${escapeHtml(device.name)}</strong>
            <span>${escapeHtml(device.type)} · ${escapeHtml(device.location)}</span>
            <small>${fields || "No fields"}</small>
        `;

        item.addEventListener("click", async () => {
            state.selectedDeviceId = device.id;
            state.selectedChartFieldKey = device.fields[0]?.field_key || null;
            saveSelection();

            renderDevices();
            renderDeviceContext();
            await loadMeasurements(true);
        });

        deviceList.appendChild(item);
    }
}


function renderDeviceContext() {
    const selectedDevice = getSelectedDevice();

    chartFieldSelect.innerHTML = "";
    measurementFields.innerHTML = "";

    if (!selectedDevice) {
        selectedDeviceShort.textContent = "None";
        selectedDeviceTitle.textContent = "No device selected.";
        measurementHint.textContent = "Select a device first.";
        measurementForm.classList.add("disabled-form");
        deleteDeviceButton.disabled = true;
        return;
    }

    selectedDeviceShort.textContent = selectedDevice.name;
    selectedDeviceTitle.textContent = `${selectedDevice.name} · ${selectedDevice.type} · ${selectedDevice.location}`;
    measurementHint.textContent = `Adding data for: ${selectedDevice.name}`;
    measurementForm.classList.remove("disabled-form");
    deleteDeviceButton.disabled = false;

    for (const field of selectedDevice.fields) {
        const option = document.createElement("option");
        option.value = field.field_key;
        option.textContent = `${field.label}${field.unit ? ` (${field.unit})` : ""}`;
        chartFieldSelect.appendChild(option);

        const label = document.createElement("label");
        label.innerHTML = `
            ${escapeHtml(field.label)} ${field.unit ? `<span class="muted">(${escapeHtml(field.unit)})</span>` : ""}
            <input
                type="number"
                step="0.0001"
                data-field-key="${escapeHtml(field.field_key)}"
                placeholder="Enter value"
            >
        `;

        measurementFields.appendChild(label);
    }

    if (state.selectedChartFieldKey) {
        chartFieldSelect.value = state.selectedChartFieldKey;
    }

    chartPeriodSelect.value = state.selectedPeriod;
}


function renderNewDeviceFields() {
    newDeviceFields.innerHTML = "";

    if (state.newDeviceFields.length === 0) {
        newDeviceFields.innerHTML = `<p class="muted">No fields added yet.</p>`;
        return;
    }

    state.newDeviceFields.forEach((field, index) => {
        const item = document.createElement("div");
        item.className = "field-item";

        item.innerHTML = `
            <span>
                <strong>${escapeHtml(field.label)}</strong>
                ${field.unit ? `<small>${escapeHtml(field.unit)}</small>` : ""}
            </span>
            <button type="button" class="danger">Remove</button>
        `;

        item.querySelector("button").addEventListener("click", () => {
            state.newDeviceFields.splice(index, 1);
            renderNewDeviceFields();
        });

        newDeviceFields.appendChild(item);
    });
}


function addNewDeviceField(label, unit) {
    const cleanLabel = String(label || "").trim();
    const cleanUnit = String(unit || "").trim();

    if (!cleanLabel) {
        setDashboardMessage("Field name is required.", true);
        return;
    }

    const alreadyExists = state.newDeviceFields.some(
        field => field.label.toLowerCase() === cleanLabel.toLowerCase()
    );

    if (alreadyExists) {
        setDashboardMessage("This field already exists for the new device.", true);
        return;
    }

    state.newDeviceFields.push({
        label: cleanLabel,
        unit: cleanUnit
    });

    renderNewDeviceFields();
    setDashboardMessage("");
}


function renderMeasurements() {
    measurementTable.innerHTML = "";

    if (state.measurements.length === 0) {
        measurementTable.innerHTML = `
            <tr>
                <td colspan="6" class="muted">No measurements for selected period.</td>
            </tr>
        `;
        return;
    }

    for (const measurement of state.measurements.slice(0, 80)) {
        const row = document.createElement("tr");

        row.innerHTML = `
            <td>${measurement.id}</td>
            <td>${escapeHtml(measurement.label)}</td>
            <td>${Number(measurement.numeric_value).toFixed(4)}</td>
            <td>${escapeHtml(measurement.unit || "")}</td>
            <td>${formatDate(measurement.created_at)}</td>
            <td><button type="button" class="danger table-action">Delete</button></td>
        `;

        row.querySelector("button").addEventListener("click", async () => {
            const confirmed = window.confirm(
                `Delete measurement #${measurement.id} for ${measurement.label}?`
            );

            if (!confirmed) {
                return;
            }

            try {
                await apiRequest(`/api/measurements/${measurement.id}`, {
                    method: "DELETE"
                });
                await refreshAll(true);
                setDashboardMessage("Measurement deleted.");
            } catch (error) {
                setDashboardMessage(error.message, true);
            }
        });

        measurementTable.appendChild(row);
    }
}


function renderAdminUsers() {
    if (!state.isAdmin) {
        adminPanel.classList.add("hidden");
        userTable.innerHTML = "";
        return;
    }

    adminPanel.classList.remove("hidden");
    userTable.innerHTML = "";

    if (state.users.length === 0) {
        userTable.innerHTML = `
            <tr>
                <td colspan="7" class="muted">No users found.</td>
            </tr>
        `;
        return;
    }

    for (const user of state.users) {
        const row = document.createElement("tr");

        row.innerHTML = `
            <td>${user.id}</td>
            <td>${escapeHtml(user.username)}</td>
            <td>${user.is_admin ? "Admin" : "User"}</td>
            <td>${user.device_count}</td>
            <td>${user.measurement_count}</td>
            <td>${formatDate(user.created_at)}</td>
            <td></td>
        `;

        const actionCell = row.lastElementChild;

        if (user.username === state.username) {
            actionCell.innerHTML = `<span class="muted">Current account</span>`;
        } else {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "danger table-action";
            button.textContent = "Delete";

            button.addEventListener("click", async () => {
                const confirmed = window.confirm(
                    `Delete user ${user.username} and all owned devices/data?`
                );

                if (!confirmed) {
                    return;
                }

                try {
                    await apiRequest(`/api/users/${user.id}`, {
                        method: "DELETE"
                    });
                    await refreshAll(true);
                    setDashboardMessage(`User ${user.username} deleted.`);
                } catch (error) {
                    setDashboardMessage(error.message, true);
                }
            });

            actionCell.appendChild(button);
        }

        userTable.appendChild(row);
    }
}


function getChartPoints() {
    if (!state.selectedChartFieldKey) {
        return [];
    }

    return state.measurements
        .filter(item => item.field_key === state.selectedChartFieldKey)
        .map(item => ({
            x: new Date(item.created_at).getTime(),
            y: Number(item.numeric_value),
            label: item.label,
            unit: item.unit || "",
            created_at: item.created_at
        }))
        .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
        .sort((a, b) => a.x - b.x);
}


function resetChartState() {
    const points = getChartPoints();

    if (points.length === 0) {
        state.chartView = null;
        return;
    }

    const xValues = points.map(point => point.x);
    const yValues = points.map(point => point.y);

    let xMin = Math.min(...xValues);
    let xMax = Math.max(...xValues);

    if (xMin === xMax) {
        xMin -= 60_000;
        xMax += 60_000;
    }

    let yMin = Math.min(...yValues);
    let yMax = Math.max(...yValues);

    if (yMin === yMax) {
        yMin -= 1;
        yMax += 1;
    }

    const yPadding = (yMax - yMin) * 0.15;

    state.chartView = {
        xMin,
        xMax,
        yMin: yMin - yPadding,
        yMax: yMax + yPadding
    };
}


function getCanvasPlotArea() {
    return {
        left: 64,
        right: chartCanvas.width - 24,
        top: 24,
        bottom: chartCanvas.height - 48
    };
}


function dataToCanvasX(x, plot) {
    const view = state.chartView;
    return plot.left + ((x - view.xMin) / (view.xMax - view.xMin)) * (plot.right - plot.left);
}


function dataToCanvasY(y, plot) {
    const view = state.chartView;
    return plot.bottom - ((y - view.yMin) / (view.yMax - view.yMin)) * (plot.bottom - plot.top);
}


function canvasToDataX(canvasX, plot) {
    const view = state.chartView;
    return view.xMin + ((canvasX - plot.left) / (plot.right - plot.left)) * (view.xMax - view.xMin);
}


function canvasToDataY(canvasY, plot) {
    const view = state.chartView;
    return view.yMax - ((canvasY - plot.top) / (plot.bottom - plot.top)) * (view.yMax - view.yMin);
}


function drawChart() {
    const ctx = chartCanvas.getContext("2d");
    const points = getChartPoints();

    ctx.clearRect(0, 0, chartCanvas.width, chartCanvas.height);

    if (points.length === 0 || !state.chartView) {
        ctx.font = "16px Arial";
        ctx.fillText("No chart data for this device/field/period.", 40, 60);
        chartTooltip.classList.add("hidden");
        return;
    }

    const plot = getCanvasPlotArea();

    ctx.lineWidth = 1;
    ctx.strokeRect(plot.left, plot.top, plot.right - plot.left, plot.bottom - plot.top);

    ctx.font = "12px Arial";

    for (let i = 0; i <= 5; i++) {
        const ratio = i / 5;
        const y = plot.bottom - ratio * (plot.bottom - plot.top);
        const value = state.chartView.yMin + ratio * (state.chartView.yMax - state.chartView.yMin);

        ctx.beginPath();
        ctx.moveTo(plot.left, y);
        ctx.lineTo(plot.right, y);
        ctx.stroke();

        ctx.fillText(value.toFixed(2), 8, y + 4);
    }

    for (let i = 0; i <= 4; i++) {
        const ratio = i / 4;
        const x = plot.left + ratio * (plot.right - plot.left);
        const value = state.chartView.xMin + ratio * (state.chartView.xMax - state.chartView.xMin);

        ctx.beginPath();
        ctx.moveTo(x, plot.top);
        ctx.lineTo(x, plot.bottom);
        ctx.stroke();

        ctx.fillText(formatShortDate(value), x - 36, chartCanvas.height - 20);
    }

    ctx.beginPath();

    let hasVisiblePoint = false;

    points.forEach((point, index) => {
        const x = dataToCanvasX(point.x, plot);
        const y = dataToCanvasY(point.y, plot);

        if (x < plot.left - 20 || x > plot.right + 20 || y < plot.top - 20 || y > plot.bottom + 20) {
            return;
        }

        if (!hasVisiblePoint) {
            ctx.moveTo(x, y);
            hasVisiblePoint = true;
        } else {
            ctx.lineTo(x, y);
        }
    });

    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.lineWidth = 1;

    for (const point of points) {
        const x = dataToCanvasX(point.x, plot);
        const y = dataToCanvasY(point.y, plot);

        if (x < plot.left || x > plot.right || y < plot.top || y > plot.bottom) {
            continue;
        }

        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
    }

    if (state.hoverPoint) {
        const x = dataToCanvasX(state.hoverPoint.x, plot);
        const y = dataToCanvasY(state.hoverPoint.y, plot);

        ctx.beginPath();
        ctx.moveTo(x, plot.top);
        ctx.lineTo(x, plot.bottom);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fill();
    }
}


function updateHoverPoint(event) {
    const points = getChartPoints();

    if (points.length === 0 || !state.chartView) {
        state.hoverPoint = null;
        return;
    }

    const rect = chartCanvas.getBoundingClientRect();
    const scaleX = chartCanvas.width / rect.width;
    const scaleY = chartCanvas.height / rect.height;
    const canvasX = (event.clientX - rect.left) * scaleX;
    const canvasY = (event.clientY - rect.top) * scaleY;
    const plot = getCanvasPlotArea();

    if (canvasX < plot.left || canvasX > plot.right || canvasY < plot.top || canvasY > plot.bottom) {
        state.hoverPoint = null;
        chartTooltip.classList.add("hidden");
        return;
    }

    let bestPoint = null;
    let bestDistance = Infinity;

    for (const point of points) {
        const x = dataToCanvasX(point.x, plot);
        const distance = Math.abs(x - canvasX);

        if (distance < bestDistance) {
            bestDistance = distance;
            bestPoint = point;
        }
    }

    state.hoverPoint = bestPoint;

    if (bestPoint) {
        const tooltipX = dataToCanvasX(bestPoint.x, plot);
        const tooltipY = dataToCanvasY(bestPoint.y, plot);

        chartTooltip.innerHTML = `
            <strong>${escapeHtml(bestPoint.label)}</strong><br>
            ${bestPoint.y.toFixed(4)} ${escapeHtml(bestPoint.unit)}<br>
            ${formatDate(bestPoint.created_at)}
        `;

        chartTooltip.style.left = `${tooltipX + 12}px`;
        chartTooltip.style.top = `${tooltipY + 12}px`;
        chartTooltip.classList.remove("hidden");
    }
}


function zoomChart(event) {
    if (!state.chartView) {
        return;
    }

    event.preventDefault();

    const rect = chartCanvas.getBoundingClientRect();
    const scaleX = chartCanvas.width / rect.width;
    const scaleY = chartCanvas.height / rect.height;
    const canvasX = (event.clientX - rect.left) * scaleX;
    const canvasY = (event.clientY - rect.top) * scaleY;
    const plot = getCanvasPlotArea();

    const zoomFactor = event.deltaY > 0 ? 1.2 : 0.8;

    if (event.shiftKey) {
        const centerY = canvasToDataY(canvasY, plot);
        const yMin = centerY - (centerY - state.chartView.yMin) * zoomFactor;
        const yMax = centerY + (state.chartView.yMax - centerY) * zoomFactor;

        if (Math.abs(yMax - yMin) > 0.0001) {
            state.chartView.yMin = yMin;
            state.chartView.yMax = yMax;
        }
    } else {
        const centerX = canvasToDataX(canvasX, plot);
        const xMin = centerX - (centerX - state.chartView.xMin) * zoomFactor;
        const xMax = centerX + (state.chartView.xMax - centerX) * zoomFactor;

        if (Math.abs(xMax - xMin) > 1000) {
            state.chartView.xMin = xMin;
            state.chartView.xMax = xMax;
        }
    }

    updateHoverPoint(event);
    drawChart();
}


function startChartDrag(event) {
    if (!state.chartView) {
        return;
    }

    state.isDraggingChart = true;

    state.dragStart = {
        clientX: event.clientX,
        clientY: event.clientY,
        view: { ...state.chartView }
    };
}


function dragChart(event) {
    if (!state.isDraggingChart || !state.dragStart || !state.chartView) {
        updateHoverPoint(event);
        drawChart();
        return;
    }

    const rect = chartCanvas.getBoundingClientRect();
    const plot = getCanvasPlotArea();

    const dxPixels = event.clientX - state.dragStart.clientX;
    const dyPixels = event.clientY - state.dragStart.clientY;

    const xRange = state.dragStart.view.xMax - state.dragStart.view.xMin;
    const yRange = state.dragStart.view.yMax - state.dragStart.view.yMin;

    const dxData = -(dxPixels / rect.width) * xRange;
    const dyData = (dyPixels / rect.height) * yRange;

    state.chartView.xMin = state.dragStart.view.xMin + dxData;
    state.chartView.xMax = state.dragStart.view.xMax + dxData;
    state.chartView.yMin = state.dragStart.view.yMin + dyData;
    state.chartView.yMax = state.dragStart.view.yMax + dyData;

    chartTooltip.classList.add("hidden");
    drawChart();
}


function stopChartDrag() {
    state.isDraggingChart = false;
    state.dragStart = null;
}


async function refreshAll(resetChart = true) {
    await loadDashboard();
    await loadDevices();
    await Promise.all([
        loadMeasurements(resetChart),
        loadUsers()
    ]);
}


loginForm.addEventListener("submit", async event => {
    event.preventDefault();

    const username = document.getElementById("loginUsername").value;
    const password = document.getElementById("loginPassword").value;

    try {
        const data = await apiRequest("/api/login", {
            method: "POST",
            body: JSON.stringify({ username, password })
        });

        state.token = data.token;
        state.username = data.username;
        state.isAdmin = Boolean(data.is_admin);
        persistSession();

        showDashboard();
        await refreshAll(true);
    } catch (error) {
        setLoginMessage(error.message, true);
    }
});


registerForm.addEventListener("submit", async event => {
    event.preventDefault();

    const username = document.getElementById("registerUsername").value;
    const password = document.getElementById("registerPassword").value;

    try {
        const data = await apiRequest("/api/register", {
            method: "POST",
            body: JSON.stringify({ username, password })
        });

        state.token = data.token;
        state.username = data.username;
        state.isAdmin = Boolean(data.is_admin);
        persistSession();

        showDashboard();
        await refreshAll(true);
    } catch (error) {
        setLoginMessage(error.message, true);
    }
});


logoutButton.addEventListener("click", () => {
    clearSession();
    showLogin();
});


deleteDeviceButton.addEventListener("click", async () => {
    const selectedDevice = getSelectedDevice();

    if (!selectedDevice) {
        setDashboardMessage("Select a device first.", true);
        return;
    }

    const confirmed = window.confirm(
        `Delete device ${selectedDevice.name} and all its measurements?`
    );

    if (!confirmed) {
        return;
    }

    try {
        await apiRequest(`/api/devices/${selectedDevice.id}`, {
            method: "DELETE"
        });

        state.selectedDeviceId = null;
        state.selectedChartFieldKey = null;
        saveSelection();
        await refreshAll(true);
        setDashboardMessage("Device deleted.");
    } catch (error) {
        setDashboardMessage(error.message, true);
    }
});


document.querySelectorAll(".quick-fields button").forEach(button => {
    button.addEventListener("click", () => {
        addNewDeviceField(button.dataset.label, button.dataset.unit);
    });
});


addFieldButton.addEventListener("click", () => {
    addNewDeviceField(newFieldLabel.value, newFieldUnit.value);
    newFieldLabel.value = "";
    newFieldUnit.value = "";
});


deviceForm.addEventListener("submit", async event => {
    event.preventDefault();

    const name = document.getElementById("deviceName").value;
    const type = document.getElementById("deviceType").value;
    const location = document.getElementById("deviceLocation").value;

    if (state.newDeviceFields.length === 0) {
        setDashboardMessage("Add at least one data field for the device.", true);
        return;
    }

    try {
        const device = await apiRequest("/api/devices", {
            method: "POST",
            body: JSON.stringify({
                name,
                type,
                location,
                fields: state.newDeviceFields
            })
        });

        deviceForm.reset();
        state.newDeviceFields = [];
        state.selectedDeviceId = device.id;
        state.selectedChartFieldKey = null;

        renderNewDeviceFields();
        await refreshAll(true);

        setDashboardMessage("Device added.");
    } catch (error) {
        setDashboardMessage(error.message, true);
    }
});


measurementForm.addEventListener("submit", async event => {
    event.preventDefault();

    const selectedDevice = getSelectedDevice();

    if (!selectedDevice) {
        setDashboardMessage("Select a device first.", true);
        return;
    }

    const values = {};

    measurementFields.querySelectorAll("input[data-field-key]").forEach(input => {
        if (input.value !== "") {
            values[input.dataset.fieldKey] = Number(input.value);
        }
    });

    if (Object.keys(values).length === 0) {
        setDashboardMessage("Enter at least one measurement value.", true);
        return;
    }

    try {
        await apiRequest("/api/measurements", {
            method: "POST",
            body: JSON.stringify({
                device_id: selectedDevice.id,
                timestamp: measurementTimestamp.value || null,
                values
            })
        });

        measurementFields.querySelectorAll("input[data-field-key]").forEach(input => {
            input.value = "";
        });

        await refreshAll(true);

        setDashboardMessage("Measurement added.");
    } catch (error) {
        setDashboardMessage(error.message, true);
    }
});


chartFieldSelect.addEventListener("change", () => {
    state.selectedChartFieldKey = chartFieldSelect.value;
    saveSelection();
    resetChartState();
    drawChart();
});


chartPeriodSelect.addEventListener("change", async () => {
    state.selectedPeriod = chartPeriodSelect.value;
    saveSelection();
    await loadMeasurements(true);
});


resetChartButton.addEventListener("click", () => {
    resetChartState();
    drawChart();
});


chartCanvas.addEventListener("wheel", zoomChart);
chartCanvas.addEventListener("mousedown", startChartDrag);
chartCanvas.addEventListener("mousemove", dragChart);
chartCanvas.addEventListener("mouseup", stopChartDrag);
chartCanvas.addEventListener("mouseleave", () => {
    stopChartDrag();
    state.hoverPoint = null;
    chartTooltip.classList.add("hidden");
    drawChart();
});
chartCanvas.addEventListener("dblclick", () => {
    resetChartState();
    drawChart();
});


function formatDate(value) {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return value;
    }

    return date.toLocaleString();
}


function formatShortDate(value) {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return "";
    }

    return date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
    });
}


function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}


async function boot() {
    renderNewDeviceFields();

    if (!state.token) {
        showLogin();
        return;
    }

    try {
        showDashboard();
        await refreshAll(true);
    } catch (error) {
        clearSession();
        showLogin();
        setLoginMessage("Session expired. Please login again.", true);
    }
}


boot();
