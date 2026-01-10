# Lancer en arrière-plan la backdoor

```
Start-Process -FilePath ".\rpc_server.exe" -ArgumentList "50001" -WindowStyle Hidden
```

# Arrêter le process

```
Stop-Process -Name "rpc_server" -Force
```
