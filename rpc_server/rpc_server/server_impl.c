#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "Interface_h.h"

#define MAX_COMMANDS 100
#define BUFFER_SIZE 65536

// Structure to track running commands
typedef struct {
    int id;
    int is_active;
    int is_finished;
    HANDLE hProcess;
    HANDLE hThread;
    HANDLE hReadPipe;
    char* output_buffer;
    size_t output_size;
    size_t output_capacity;
    CRITICAL_SECTION cs;
} CommandContext;

static CommandContext g_commands[MAX_COMMANDS];
static int g_next_command_id = 1;
static CRITICAL_SECTION g_commands_cs;
static BOOL g_initialized = FALSE;

// Initialize command tracking
void InitializeCommands() {
    if (!g_initialized) {
        InitializeCriticalSection(&g_commands_cs);
        for (int i = 0; i < MAX_COMMANDS; i++) {
            g_commands[i].is_active = FALSE;
            g_commands[i].output_buffer = NULL;
        }
        g_initialized = TRUE;
    }
}

// Find a free command slot
CommandContext* AllocateCommand() {
    EnterCriticalSection(&g_commands_cs);
    
    for (int i = 0; i < MAX_COMMANDS; i++) {
        if (!g_commands[i].is_active) {
            g_commands[i].id = g_next_command_id++;
            g_commands[i].is_active = TRUE;
            g_commands[i].is_finished = FALSE;
            g_commands[i].output_size = 0;
            g_commands[i].output_capacity = BUFFER_SIZE;
            g_commands[i].output_buffer = (char*)malloc(BUFFER_SIZE);
            if (g_commands[i].output_buffer) {
                g_commands[i].output_buffer[0] = '\0';
            }
            InitializeCriticalSection(&g_commands[i].cs);
            
            LeaveCriticalSection(&g_commands_cs);
            return &g_commands[i];
        }
    }
    
    LeaveCriticalSection(&g_commands_cs);
    return NULL;
}

// Find command by ID
CommandContext* FindCommand(int command_id) {
    EnterCriticalSection(&g_commands_cs);
    
    for (int i = 0; i < MAX_COMMANDS; i++) {
        if (g_commands[i].is_active && g_commands[i].id == command_id) {
            LeaveCriticalSection(&g_commands_cs);
            return &g_commands[i];
        }
    }
    
    LeaveCriticalSection(&g_commands_cs);
    return NULL;
}

// Append output to command buffer
void AppendOutput(CommandContext* ctx, const char* data, size_t len) {
    EnterCriticalSection(&ctx->cs);
    
    // Ensure buffer has enough space
    while (ctx->output_size + len + 1 > ctx->output_capacity) {
        ctx->output_capacity *= 2;
        char* new_buffer = (char*)realloc(ctx->output_buffer, ctx->output_capacity);
        if (new_buffer) {
            ctx->output_buffer = new_buffer;
        } else {
            LeaveCriticalSection(&ctx->cs);
            return;
        }
    }
    
    memcpy(ctx->output_buffer + ctx->output_size, data, len);
    ctx->output_size += len;
    ctx->output_buffer[ctx->output_size] = '\0';
    
    LeaveCriticalSection(&ctx->cs);
}

// Thread function to read command output
DWORD WINAPI CommandReaderThread(LPVOID param) {
    CommandContext* ctx = (CommandContext*)param;
    char buffer[4096];
    DWORD bytes_read;
    
    while (ReadFile(ctx->hReadPipe, buffer, sizeof(buffer) - 1, &bytes_read, NULL) && bytes_read > 0) {
        buffer[bytes_read] = '\0';
        AppendOutput(ctx, buffer, bytes_read);
    }
    
    // Wait for process to finish
    WaitForSingleObject(ctx->hProcess, INFINITE);
    
    EnterCriticalSection(&ctx->cs);
    ctx->is_finished = TRUE;
    LeaveCriticalSection(&ctx->cs);
    
    CloseHandle(ctx->hReadPipe);
    CloseHandle(ctx->hProcess);
    
    return 0;
}

// RPC function: Launch a command
int LaunchCommand(handle_t hBinding, const char* command) {
    printf("LaunchCommand called: %s\n", command);
    
    InitializeCommands();
    
    CommandContext* ctx = AllocateCommand();
    if (!ctx) {
        printf("Error: No free command slots\n");
        return -1;
    }
    
    // Create pipes for command output
    HANDLE hWritePipe;
    SECURITY_ATTRIBUTES sa = { sizeof(SECURITY_ATTRIBUTES), NULL, TRUE };
    
    if (!CreatePipe(&ctx->hReadPipe, &hWritePipe, &sa, 0)) {
        printf("Error: CreatePipe failed\n");
        ctx->is_active = FALSE;
        return -1;
    }
    
    // Make read handle non-inheritable
    SetHandleInformation(ctx->hReadPipe, HANDLE_FLAG_INHERIT, 0);
    
    // Prepare command execution
    STARTUPINFOA si = { sizeof(STARTUPINFOA) };
    PROCESS_INFORMATION pi;
    
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.hStdOutput = hWritePipe;
    si.hStdError = hWritePipe;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    si.wShowWindow = SW_HIDE;
    
    // Build command line with cmd.exe
    char cmd_line[4096];
    snprintf(cmd_line, sizeof(cmd_line), "cmd.exe /c %s", command);
    
    // Create process
    if (!CreateProcessA(NULL, cmd_line, NULL, NULL, TRUE, 
                        CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        printf("Error: CreateProcess failed: %d\n", GetLastError());
        CloseHandle(ctx->hReadPipe);
        CloseHandle(hWritePipe);
        ctx->is_active = FALSE;
        return -1;
    }
    
    ctx->hProcess = pi.hProcess;
    CloseHandle(pi.hThread);
    CloseHandle(hWritePipe);
    
    // Create reader thread
    ctx->hThread = CreateThread(NULL, 0, CommandReaderThread, ctx, 0, NULL);
    
    printf("Command launched with ID: %d\n", ctx->id);
    return ctx->id;
}

// RPC function: Get command output
int GetCommandOutput(handle_t hBinding, int command_id, char** output, int* is_finished) {
    printf("GetCommandOutput called for command ID: %d\n", command_id);
    
    CommandContext* ctx = FindCommand(command_id);
    if (!ctx) {
        printf("Error: Command not found\n");
        *output = NULL;
        *is_finished = 0;
        return -1;
    }
    
    EnterCriticalSection(&ctx->cs);
    
    // Allocate output string
    *output = (char*)midl_user_allocate(ctx->output_size + 1);
    if (*output) {
        memcpy(*output, ctx->output_buffer, ctx->output_size + 1);
    }
    
    *is_finished = ctx->is_finished;
    
    LeaveCriticalSection(&ctx->cs);
    
    printf("Returning %zu bytes, finished=%d\n", ctx->output_size, *is_finished);
    return 0;
}

// RPC function: Stop a command
int StopCommand(handle_t hBinding, int command_id) {
    printf("StopCommand called for command ID: %d\n", command_id);
    
    CommandContext* ctx = FindCommand(command_id);
    if (!ctx) {
        printf("Error: Command not found\n");
        return -1;
    }
    
    // Terminate process
    TerminateProcess(ctx->hProcess, 1);
    
    // Wait for thread to finish
    WaitForSingleObject(ctx->hThread, 5000);
    CloseHandle(ctx->hThread);
    
    // Cleanup
    EnterCriticalSection(&ctx->cs);
    if (ctx->output_buffer) {
        free(ctx->output_buffer);
        ctx->output_buffer = NULL;
    }
    LeaveCriticalSection(&ctx->cs);
    
    DeleteCriticalSection(&ctx->cs);
    ctx->is_active = FALSE;
    
    printf("Command %d stopped\n", command_id);
    return 0;
}
