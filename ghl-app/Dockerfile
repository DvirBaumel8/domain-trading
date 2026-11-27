FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1
RUN useradd --create-home --uid 10001 app
WORKDIR /app
COPY --chown=app:app . /app
USER app
EXPOSE 8080
CMD ["python3", "app.py"]
