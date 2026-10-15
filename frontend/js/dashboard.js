/**
 * Compatibility entry point for the dashboard.
 * The production dashboard is rendered by the single-page app in index.html.
 */
function showDashboard() {
    if (!window.app || typeof window.app.open !== "function") {
        throw new Error("The SAP workbench application has not initialized.");
    }
    window.app.open("dashboard");
}