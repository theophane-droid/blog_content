# include <stdio.h>
#include "Interface_h.h"

void MyRemoteProc(
	handle_t h,
	int param,
	int* outNumber
) {
	*outNumber = param + 1;
}