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
    printf("Usage: %s [-e] <server_ip> [<port>]\n", program_name);
    printf("\nOptions:\n");
    printf("  -e              Use endpoint mapper (port 135) to discover service\n");
    printf("  <server_ip>     IP address or hostname of the server\n");
    printf("  <port>          Port number (only without -e flag)\n");
    printf("\nExamples:\n");
    printf("  %s localhost 50001        - Connect to specific port\n", program_name);
    printf("  %s -e localhost           - Use endpoint mapper to discover port\n", program_name);
    printf("  %s -e 192.168.1.31        - Use endpoint mapper on remote server\n", program_name);
}

int main(int argc, char* argv[]) {
    RPC_STATUS status;
    RPC_WSTR stringBinding = NULL;
    handle_t hBinding = NULL;
    wchar_t server_ip[256];
    wchar_t port[16] = {0};
    BOOL use_endpoint_mapper = FALSE;
    int arg_idx = 1;
    
    // Parse command line arguments
    if (argc < 2 || argc > 4) {
        print_usage(argv[0]);
        return 1;
    }
    
    // Check for -e flag
    if (strcmp(argv[1], "-e") == 0) {
        use_endpoint_mapper = TRUE;
        arg_idx = 2;
        
        if (argc < 3) {
            print_usage(argv[0]);
            return 1;
        }
    } else {
        // Without -e, we need exactly 3 arguments (program, ip, port)
        if (argc != 3) {
            print_usage(argv[0]);
            return 1;
        }
    }
    
    // Get server IP
    MultiByteToWideChar(CP_ACP, 0, argv[arg_idx], -1, server_ip, 256);
    
    // Get port if not using endpoint mapper
    if (!use_endpoint_mapper) {
        if (argc > arg_idx + 1) {
            MultiByteToWideChar(CP_ACP, 0, argv[arg_idx + 1], -1, port, 16);
        } else {
            print_usage(argv[0]);
            return 1;
        }
    }
    
    if (use_endpoint_mapper) {
        printf("Connecting to server %ls using endpoint mapper...\n", server_ip);
        
        // Create binding string without port - will query endpoint mapper
        status = RpcStringBindingCompose(
            NULL,
            (RPC_WSTR)L"ncacn_ip_tcp",
            server_ip,
            NULL,  // NULL = query endpoint mapper on port 135
            NULL,
            &stringBinding
        );
        
    } else {
        printf("Connecting to server %ls:%ls...\n", server_ip, port);
        
        // Create binding string with specific port
        status = RpcStringBindingCompose(
            NULL,
            (RPC_WSTR)L"ncacn_ip_tcp",
            server_ip,
            port,
            NULL,
            &stringBinding
        );
    }
    
    if (status != RPC_S_OK) {
        printf("Error RpcStringBindingCompose: 0x%x\n", status);
        return 1;
    }
    
    // Create binding handle
    status = RpcBindingFromStringBinding(stringBinding, &hBinding);
    RpcStringFree(&stringBinding);
    
    if (status != RPC_S_OK) {
        printf("Error RpcBindingFromStringBinding: 0x%x\n", status);
        return 1;
    }
    
    // If using endpoint mapper, resolve the endpoint
    if (use_endpoint_mapper) {
        printf("Resolving endpoint from endpoint mapper...\n");
        
        status = RpcEpResolveBinding(hBinding, MyInterface_v1_0_c_ifspec);
        
        if (status != RPC_S_OK) {
            printf("Error RpcEpResolveBinding: 0x%x\n", status);
            printf("Make sure:\n");
            printf("  1. Server is running with -e flag\n");
            printf("  2. Port 135 (endpoint mapper) is accessible\n");
            printf("  3. Firewall allows RPC traffic\n");
            RpcBindingFree(&hBinding);
            return 1;
        }
        
        printf("Endpoint resolved successfully!\n");
    }
    
    // Disable authentication
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
        printf("4. Interactive shell\n");
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
            else if (choice[0] == '4') {
                char command[1024];

                printf("\n[RPC SHELL] Type 'exit' to quit\n");

                while (1) {
                    printf("rpc> ");
                    if (!fgets(command, sizeof(command), stdin))
                        break;

                    command[strcspn(command, "\n")] = 0;

                    if (strcmp(command, "exit") == 0)
                        break;

                    int cmd_id = LaunchCommand(hBinding, command);
                    if (cmd_id <= 0) {
                        printf("Failed to launch command\n");
                        continue;
                    }

                    // Poll output
                    while (1) {
                        char* output = NULL;
                        int finished = 0;

                        int res = GetCommandOutput(hBinding, cmd_id, &output, &finished);
                        if (res == 0 && output) {
                            printf("%s", output);
                            midl_user_free(output);
                        }

                        if (finished)
                            break;

                        Sleep(300);
                    }
                }
            }
        }
        RpcExcept(1) {
            unsigned long exception = RpcExceptionCode();
            printf("RPC Exception: 0x%x\n", exception);
            
            if (exception == RPC_S_SERVER_UNAVAILABLE || exception == 0x6ba) {
                printf("Server unavailable - connection lost\n");
                break;
            }
        }
        RpcEndExcept
    }
    
    RpcBindingFree(&hBinding);
    printf("Disconnected.\n");
    return 0;
}
