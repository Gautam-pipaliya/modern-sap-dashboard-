#!/bin/bash
set -Eeuo pipefail

ai_api_key="${AI_API_KEY:-${GEMINI_API_KEY:-${OPENAI_API_KEY:-}}}"
ai_model="${AI_MODEL:-${GEMINI_MODEL:-${OPENAI_MODEL:-gemini-3.8-flash}}}"
ai_base_url="${AI_BASE_URL:-${GEMINI_BASE_URL:-${OPENAI_BASE_URL:-https://generativelanguage.googleapis.com/v1beta/openai/}}}"
ai_timeout="${AI_TIMEOUT_SECONDS:-${GEMINI_TIMEOUT_SECONDS:-${OPENAI_TIMEOUT_SECONDS:-60}}}"
ai_trust_env="${AI_TRUST_ENV:-${GEMINI_TRUST_ENV:-${OPENAI_TRUST_ENV:-true}}}"
ai_max_output_tokens="${AI_MAX_OUTPUT_TOKENS:-${GEMINI_MAX_OUTPUT_TOKENS:-12000}}"
ai_max_concurrent_requests="${AI_MAX_CONCURRENT_REQUESTS:-1}"

chatbot_pid=
node_pid=

start_chatbot() {
    gosu chatbot env -i \
        PATH="/opt/chatbot-venv/bin:/usr/local/bin:/usr/bin:/bin" \
        HOME=/home/chatbot \
        PYTHONDONTWRITEBYTECODE=1 \
        PYTHONUNBUFFERED=1 \
        COPILOT_HOST=127.0.0.1 \
        COPILOT_PORT=8000 \
        COPILOT_MEMORY_DB=/tmp/copilot_memory.sqlite3 \
        AI_PROVIDER="${AI_PROVIDER:-auto}" \
        AI_API_KEY="$ai_api_key" \
        AI_MODEL="$ai_model" \
        AI_BASE_URL="$ai_base_url" \
        AI_TIMEOUT_SECONDS="$ai_timeout" \
        AI_TRUST_ENV="$ai_trust_env" \
        AI_MAX_OUTPUT_TOKENS="$ai_max_output_tokens" \
        AI_MAX_CONCURRENT_REQUESTS="$ai_max_concurrent_requests" \
        /opt/chatbot-venv/bin/python /app/app.py &
    chatbot_pid=$!
    echo "Started private chatbot process (pid $chatbot_pid)."
}

start_dashboard() {
    gosu node env \
        -u AI_API_KEY \
        -u GEMINI_API_KEY \
        -u OPENAI_API_KEY \
        -u AI_PROVIDER \
        -u AI_MODEL \
        -u AI_BASE_URL \
        -u AI_TIMEOUT_SECONDS \
        -u AI_TRUST_ENV \
        -u AI_MAX_OUTPUT_TOKENS \
        -u AI_MAX_CONCURRENT_REQUESTS \
        -u GEMINI_MODEL \
        -u GEMINI_BASE_URL \
        -u GEMINI_TIMEOUT_SECONDS \
        -u GEMINI_TRUST_ENV \
        -u OPENAI_MODEL \
        -u OPENAI_BASE_URL \
        -u OPENAI_TIMEOUT_SECONDS \
        -u OPENAI_TRUST_ENV \
        node --use-system-ca /app/backend/server.js &
    node_pid=$!
    echo "Started public dashboard process (pid $node_pid)."
}

stop_children() {
    trap - EXIT HUP INT TERM
    if [ -n "$node_pid" ]; then
        kill -TERM "$node_pid" 2>/dev/null || true
    fi
    if [ -n "$chatbot_pid" ]; then
        kill -TERM "$chatbot_pid" 2>/dev/null || true
    fi
    if [ -n "$node_pid" ]; then
        wait "$node_pid" 2>/dev/null || true
    fi
    wait "$chatbot_pid" 2>/dev/null || true
}

trap stop_children EXIT
trap 'exit 143' HUP INT TERM

# Bind the public dashboard immediately so Render's health check can pass even
# if the private chatbot needs extra time to initialize.
start_chatbot
start_dashboard

while true; do
    set +e
    wait -n -p exited_pid "$chatbot_pid" "$node_pid"
    process_status=$?
    set -e

    if [ "$exited_pid" = "$node_pid" ]; then
        echo "Public dashboard process exited unexpectedly (status $process_status)." >&2
        if [ "$process_status" -eq 0 ]; then
            process_status=1
        fi
        exit "$process_status"
    fi

    echo "Private chatbot process exited (status $process_status); restarting in 2 seconds." >&2
    sleep 2
    start_chatbot
done
