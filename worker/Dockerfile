FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY forecast_worker.py ./

# Runs a forecast once at start, then polls for stores whose first sync just
# finished (every 30s) and runs the full nightly forecast at 02:00 UTC.
CMD ["python", "-u", "forecast_worker.py", "--loop"]
