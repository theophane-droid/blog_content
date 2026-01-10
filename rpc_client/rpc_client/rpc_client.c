#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <rpc.h>
#include "Interface_h.h"

void __RPC_FAR * __RPC_USER midl_user_allocate(size_t len) {
    return malloc(len);
}

void __RPC_USER midl_user_free(void __RPC_FAR * ptr) {
    free(ptr);
}

void print_usage(const char* program_name) {
    printf("Usage: %s <server_ip> <port>\n", program_name);
    printf("Example: %s localhost 50001\n", program_name);
}

int main(int argc, char* argv[]) {
    RPC_STATUS status;
    RPC_WSTR stringBinding = NULL;
    handle_t hBinding = NULL;
    wchar_t server_ip[256];
    wchar_t port[16];
    
    if (argc != 3) {
        print_usage(argv[0]);
        return 1;
    }
    
    MultiByteToWideChar(CP_ACP, 0, argv[1], -1, server_ip, 256);
    MultiByteToWideChar(CP_ACP, 0, argv[2], -1, port, 16);
    
    printf("Connecting to server %s:%s...\n", argv[1], argv[2]);
    
    status = RpcStringBindingCompose(NULL, (RPC_WSTR)L"ncacn_ip_tcp", 
                                     server_ip, port, NULL, &stringBinding);
    
    if (status != RPC_S_OK) {
        printf("Error RpcStringBindingCompose: 0x%x\n", status);
        return 1;
    }
    
    status = RpcBindingFromStringBinding(stringBinding, &hBinding);
    RpcStringFree(&stringBinding);
    
    if (status != RPC_S_OK) {
        printf("Error RpcBindingFromStringBinding: 0x%x\n", status);
        return 1;
    }
    
    RpcBindingSetAuthInfo(hBinding, NULL, RPC_C_AUTHN_LEVEL_NONE, 
                          RPC_C_AUTHN_NONE, NULL, RPC_C_AUTHZ_NONE);
    
    printf("Connection successful!\n\n");
    
    // Interactive menu
    char choice[10];
    int current_cmd_id = -1;
    
    while (1) {
        printf("\n=== RPC Command Executor ===\n");
        printf("1. Launch command\n");
        printf("2. Get command output\n");
        printf("3. Stop command\n");
        printf("q. Quit\n");
        printf("Choice: ");
        
        if (fgets(choice, sizeof(choice), stdin) == NULL) break;
        
        if (choice[0] == 'q' || choice[0] == 'Q') break;
        
        RpcTryExcept {
            if (choice[0] == '1') {
                char command[1024];
                printf("Enter command: ");
                if (fgets(command, sizeof(command), stdin)) {
                    command[strcspn(command, "\n")] = 0;  // Remove newline
                    
                    current_cmd_id = LaunchCommand(hBinding, command);
                    if (current_cmd_id > 0) {
                        printf("Command launched with ID: %d\n", current_cmd_id);
                    } else {
                        printf("Failed to launch command\n");
                    }
                }
            }
            else if (choice[0] == '2') {
                if (current_cmd_id <= 0) {
                    printf("No command launched yet!\n");
                } else {
                    char* output = NULL;
                    int is_finished = 0;
                    
                    int result = GetCommandOutput(hBinding, current_cmd_id, &output, &is_finished);
                    
                    if (result == 0 && output) {
                        printf("\n--- Command Output (ID: %d) ---\n", current_cmd_id);
                        printf("%s", output);
                        printf("\n--- %s ---\n", is_finished ? "FINISHED" : "RUNNING");
                        midl_user_free(output);
                    } else {
                        printf("Command not found or error\n");
                    }
                }
            }
            else if (choice[0] == '3') {
                if (current_cmd_id <= 0) {
                    printf("No command to stop!\n");
                } else {
                    int result = StopCommand(hBinding, current_cmd_id);
                    if (result == 0) {
                        printf("Command %d stopped\n", current_cmd_id);
                        current_cmd_id = -1;
                    } else {
                        printf("Failed to stop command\n");
                    }
                }
            }
        }
        RpcExcept(1) {
            printf("RPC Exception: 0x%x\n", RpcExceptionCode());
        }
        RpcEndExcept
    }
    
    RpcBindingFree(&hBinding);
    printf("Disconnected.\n");
    return 0;
}
