# Paraboni Windows Monitor

Monitor de diagnóstico para descobrir se processos Node/Tomcat estão causando ou sofrendo uma degradação no Windows Server. Ele não reinicia nem encerra aplicações.

## O que ele coleta

- CPU, memória, paginação e atividade de disco do servidor;
- CPU, memória privada, working set, threads, handles e I/O dos processos configurados;
- os dez processos com maior consumo de CPU em cada amostra;
- disponibilidade e latência de endpoints HTTP locais;
- atraso do próprio coletor, útil para identificar congelamentos;
- eventos `System` e `Application` do Windows quando um incidente é aberto.

As linhas de comando são usadas somente em memória para identificar processos. Elas não são gravadas nos arquivos de amostra.

## Requisitos

- Windows Server com PowerShell 5.1 ou superior;
- Node.js 18 ou superior;
- permissão para consultar CIM/WMI e, idealmente, executar como administrador/SYSTEM.

Não existem dependências npm.

## Configuração inicial

1. Descubra como os processos aparecem no servidor, em PowerShell elevado:

   ```powershell
   npm run preflight
   npm run discover
   ```

2. Copie a configuração de exemplo:

   ```powershell
   Copy-Item .\config.example.json .\config.json
   ```

3. Edite `config.json`. Remova os textos `SUBSTITUIR-...` e use um seletor que diferencie a aplicação dos demais processos.

   Se uma aplicação não possuir endpoint de saúde, configure `"healthChecks": []` para ela.

4. Valide:

   ```powershell
   npm run check-config
   ```

5. Execute interativamente para o primeiro teste:

   ```powershell
   npm start
   ```

Os dados serão gravados em `data\samples` e os incidentes em `data\incidents`.

Se o preflight acusar indisponibilidade de CIM, execute-o primeiro em PowerShell elevado. O monitor continua vivo quando uma fonte falha e registra `collectorWarnings`, mas não há diagnóstico confiável enquanto os contadores essenciais estiverem indisponíveis.

## Como identificar Node e Tomcat

Um target pode ser identificado de três formas:

- `serviceNames`: nome interno do Windows Service, quando existir;
- `processNames` combinado com `commandLineIncludes` ou `executablePathIncludes`;
- apenas `processNames`, como último recurso.

Exemplo de Node não instalado como Windows Service:

```json
{
  "id": "api-node",
  "label": "API Node",
  "serviceNames": [],
  "processNames": ["node.exe"],
  "executablePathIncludes": [],
  "commandLineIncludes": ["api\\server.js"],
  "healthChecks": [{
    "url": "http://127.0.0.1:3000/health",
    "timeoutMs": 3000,
    "intervalSeconds": 15
  }]
}
```

Exemplo de Tomcat executado por `java.exe`:

```json
{
  "id": "tomcat",
  "label": "Tomcat",
  "serviceNames": [],
  "processNames": ["java.exe"],
  "executablePathIncludes": [],
  "commandLineIncludes": ["catalina.base=C:\\apps\\tomcat"],
  "healthChecks": [{
    "url": "http://127.0.0.1:8080/minha-aplicacao/health",
    "timeoutMs": 5000,
    "intervalSeconds": 15
  }]
}
```

Os textos em `commandLineIncludes` não precisam reproduzir a linha inteira. Escolha um trecho estável e exclusivo.

## Incidentes

Um incidente é criado após a condição permanecer ativa pelo número configurado em `thresholds.consecutiveSamples`. Com intervalo de cinco segundos e seis amostras, o gatilho exige aproximadamente 30 segundos.

Cada pasta de incidente contém:

- `summary.json`: motivo e período;
- `samples-before.jsonl`: buffer anterior ao gatilho;
- `samples-after.jsonl`: período posterior;
- `windows-system.evtx`;
- `windows-application.evtx`;
- `event-log-export.json`: resultado da exportação dos eventos.

Os arquivos `.evtx` podem ser abertos pelo Event Viewer.

## Execução automática

Depois de validar interativamente, registre uma tarefa executada como `SYSTEM` na inicialização:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-startup-task.ps1
```

Para verificar:

```powershell
Get-ScheduledTask -TaskName ParaboniMonitor
Get-ScheduledTaskInfo -TaskName ParaboniMonitor
```

Para remover:

```powershell
Stop-ScheduledTask -TaskName ParaboniMonitor -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName ParaboniMonitor -Confirm:$false
```

## PerfMon opcional

Se já existir um Data Collector Set circular, informe seu nome em `perfmon.collectorName` e habilite `startWithMonitor`. O agente apenas inicia ou para um coletor existente; ele não cria contadores, pois os nomes variam com o idioma do Windows.

## Segurança operacional

- não configure endpoints externos: prefira `127.0.0.1`;
- não coloque credenciais na URL do health check;
- proteja a pasta `data`, pois eventos do Windows podem conter informações internas;
- defina os limites de CPU/memória por processo somente depois de observar uma linha de base;
- valide o consumo do próprio monitor antes de mantê-lo em produção.

## Testes

```powershell
npm test
```
