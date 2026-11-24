FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY smartticket ./smartticket
# downloads the public dataset and trains the models at build time (~1 min)
RUN python -m smartticket.train
EXPOSE 8000
CMD ["uvicorn", "smartticket.api:app", "--host", "0.0.0.0", "--port", "8000"]
